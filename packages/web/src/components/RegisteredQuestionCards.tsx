// The surface a REGISTERED question renders on — a question a worker created with the `ask` tool, which
// is a row in `thread_question` rather than a fence in a message. That is the whole difference, and it
// is the reason this file exists at all: a fenced question lives and dies with the message carrying it,
// so it vanishes from view the moment the transcript scrolls or the context is compacted, while a
// registration is still owed an answer tomorrow. So these cards do NOT ride the transcript on their own:
// they render at the rest that asked them, or a later one whose ```awaiting fence names them under
// `questions:` (lib/questionAnchor, upstream e157817a, 2026-10-05), and in the slot of an empty
// ```question qst_… marker the worker wrote into its handoff (lib/questionShadow PLACEMENT). The fork drew
// every open card at the bottom of the newest handoff from 2026-09-28 until this merge took upstream's
// placement instead.
//
// The CARD is the shared one (QuestionBlockCard); only the plumbing is new. What a registration adds
// over the other two producers is the STATIC TREE: an option may carry follow-ups that become live only
// once that option is picked, so one registration renders as a stack of cards that grows as it is
// answered. lib/registeredQuestion.ts performs that walk; nothing here decides which nodes are live.
//
// ONE QUESTION AT A TIME (2026-09-29, maintainer: "the agent should receive the answer to one question
// at a time so it can start working but the remaining questions … should stay there"). A question is SENT
// the moment it is complete — a single-choice pick that opens no follow-up, the last of its follow-ups
// answered, an Enter in its own box, a multi confirmed with Enter or Send — and the rest stay open and
// owed where they are. The questions of one `ask` are independent by contract (a dependent one is a
// `followUps` entry), which is what makes one answer actionable alone. A half-filled question (typed and
// not Entered, a multi not confirmed) carries its own Send answer; the group's footer button finishes the
// group, its label naming what it sends and skips (groupFinish).
//
// THE PROMPT BOX'S SEND CARRIES WHATEVER IS STAGED (upstream 59089c92, 2026-10-11). Where a
// surface mounts its thread's prompt box (lib/sendScope), that box's Send takes every staged answer
// (`take`) and the typed words as ONE turn — the server settles the answers and sends them above the
// note — so a reply typed with answers staged carries them rather than replying past them. A surface
// with no such box (the cross-project queue card) still sends them first and its reply after
// (`submit(then)`).
//
// ONE ANSWERING STATE PER THREAD, however many mounts. The staged picks, what has been sent, and the
// prompt box that carries staged answers all have to agree, so the state cannot live in the stack that
// draws the cards. `useRegisteredAnswering` holds it for the whole thread; the surface mounts it ONCE
// (RegisteredAnsweringProvider) and every stack on that surface reads it through context. Picks and text
// live in the tab's draft store, so every provider and remount sees the same staged answer; secrets,
// errors and send state stay per hook instance. A stack mounted with no provider above it (a surface that
// draws one stack) owns a state of its own.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { type QuestionAnswer, type RegisteredQuestionView, type SettledQuestionView, type ThreadView } from "@ntwine/shared"
import { rpc, type Api } from "../api/rpc.ts"
import { draftKey, draftStore, useDraftValues, useProjectDir } from "../lib/drafts.ts"
import { clearSteered, clearSteeredIn, markSteered, markSteeredIn } from "../lib/steering.ts"
import { SendScopeContext, usePromptBoxSends } from "../lib/sendScope.tsx"
import type { BlockAnswer } from "../lib/questionBlocks.ts"
import type { PairedAnswer } from "../lib/answersMessage.ts"
import { ROOT_PATH, liveQuestionNodes, nodeAnswered, questionComplete, registeredAnswer, settledQuestionNodes } from "../lib/registeredQuestion.ts"
import { decodeQuestionPick, encodeQuestionPick, questionSpecAt, type QuestionPick } from "../lib/registeredPicks.ts"
import { AnswersCard } from "./AnswersCard.tsx"
import { QueueDismissContext } from "./ChatView.tsx"
import { QuestionBlockCard, focusQuestionNode } from "./QuestionBlockCard.tsx"
import { revealInDrawerTranscript } from "../lib/drawerReveal.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { CompactQuestionList, usePhoneQuestions } from "./PhoneQuestionCards.tsx"

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "The answer could not be sent."
  return message.length > 240 ? `${message.slice(0, 239)}…` : message
}

/** The chip/toggle half of a staged answer. It lives in the draft store beside the free-text half
 *  (draftKey.questionPick), so a staged answer survives a remount, a navigation, a worker restart and the
 *  reload a dev-server restart forces — held in React state until 2026-10-08, every restart reset it.
 *  Encoded by lib/registeredPicks (upstream bd4f96b7): each option's slot AND label, so a pick never
 *  lands on a different option, and two options sharing a label stay apart. */
const NO_PICK: QuestionPick = { chosen: null, chosenSet: [] }

/** The thread's whole answering state: what is staged on every open question, and the one send. */
export interface RegisteredAnswering {
  slug: string | undefined
  answerFor: (q: RegisteredQuestionView, path: string) => BlockAnswer
  answersOf: (q: RegisteredQuestionView) => ReadonlyMap<string, BlockAnswer>
  onChip: (q: RegisteredQuestionView, path: string, isMulti: boolean, optIdx: number) => void
  onText: (q: RegisteredQuestionView, path: string, isMulti: boolean, text: string) => void
  dismiss: (id: string) => void
  dismissing: boolean
  /** Questions the × took off the card, ahead of the board read that drops them. */
  dismissed: ReadonlySet<string>
  /** The countdown's ×: Ntwine takes no recommended option on any of the thread's questions; they wait. */
  cancelDefault: () => void
  /** The thread's questions default together (shared threadQuestionDefaults), so ONE countdown speaks for
   *  them, under the last of them: `ownerId` is the card that draws it, `count` how many it will answer. */
  defaultCountdown: { ownerId: string; count: number } | undefined
  /** Send ONE question's staged answer — what completing a question does. Nothing staged: nothing sent. */
  commit: (q: RegisteredQuestionView) => void
  /** Send EVERY staged answer on the thread. With no `then`, through the surface's prompt box when it has
   *  one (lib/sendScope), so whatever is typed there goes with them in one turn; on their own otherwise.
   *  With `then` — a reply box that cannot carry answers itself (AllQueuesCard) — they go on their own and
   *  `then` runs once they have LANDED, never on a failure, so the reply goes out after them rather than
   *  instead of them. */
  submit: (then?: () => void) => void
  /** Hand every staged answer to the prompt box's send, which carries them in its own follow-up. Null
   *  when nothing is staged. */
  take: () => RegisteredTake | null
  /** The group footer's button, over `ids` — the questions of the stack it sits under, never another
   *  rest's: what is staged, plus every blank question as skipped. */
  submitGroup: (ids: ReadonlySet<string>) => void
  /** Whether `q` holds an answer nothing has sent yet — a multi's toggles, typed text, a branch partly
   *  answered, a pick held by a draft in the reply box. Its card offers its own Send while it does. */
  unsent: (q: RegisteredQuestionView) => boolean
  /** The thread's answered questions, as the settled list holds them — what a stack counts its group's
   *  progress from. Read, never fetched, here. */
  settled: readonly SettledQuestion[]
  /** Enter inside one of `q`'s cards (`grid` is that node's options grid): walk to `q`'s next unanswered
   *  follow-up; with none left, send `q` — whatever it holds, which is how a half-filled one is sent on
   *  purpose — and move to the next unanswered question. Enter never sends another question. */
  enter: (q: RegisteredQuestionView, grid: HTMLElement) => void
  /** Every question this state has sent and the server has not refused, as its greyed card will draw it.
   *  A surface that keeps the answered card in place (the queue card) reads it; the thread page draws its
   *  own from the settled list. */
  sent: ReadonlyMap<string, SettledQuestion>
  /** Answered questions the human reopened with Change, drawn open again in their slot until the new
   *  answer is sent or Keep puts the old one back. Nothing reaches the server until that send. */
  editing: ReadonlyMap<string, RegisteredQuestionView>
  /** Whether an answered question offers Change: one of the set the human is moving through — asked no
   *  earlier than the oldest still open, or in the newest ask — not a decision from an older rest the
   *  worker has long since built on. */
  canChange: (s: SettledQuestion) => boolean
  change: (s: SettledQuestion) => void
  keep: (id: string) => void
  staged: number
  sending: boolean
  error: string | undefined
}

/** The staged answers as the prompt box's send needs them, with the three edges of that send. */
export interface RegisteredTake {
  answers: QuestionAnswer[]
  /** The same answers as the human may read them back — a secret's value never reaches a bubble. */
  display: QuestionAnswer[]
  /** The send has committed locally: the cards grey in place. */
  onOptimistic: () => void
  onSuccess: () => void
  /** The send was refused. `kept`: the server holds it as a failed send, answers settled and all. */
  onRollback: (kept: boolean) => void
}

export const RegisteredAnsweringContext = createContext<RegisteredAnswering | null>(null)

/**
 * Which project a surface's answers go to, for a surface showing a project OTHER than the page's own.
 *
 * Absent — every board and drawer — the answers go where the page's `rpc` goes and the drafts key on the
 * page's board. The All queues page shows every project on a page that names none, where both of those
 * mean the LAUNCHING project: it passes the thread's own project-bound client and directory, so an
 * answer lands on the thread that asked and a half-typed one shares its draft with that project's board.
 */
export interface RegisteredAnsweringScope {
  api: Pick<Api, "answerQuestions" | "dismissQuestions" | "holdQuestionDefault" | "threadSettledQuestions">
  projectDir: string | undefined
  /** Whose steer an answer is: the project list reads it back for that project's row (lib/steering.ts). */
  projectId: string
}

/** The state behind every registered card on a surface. `thread` undefined (a stack that found a
 *  provider above it) yields an inert state nobody reads — hooks cannot be conditional. */
export function useRegisteredAnswering(thread: ThreadView | undefined, scope?: RegisteredAnsweringScope): RegisteredAnswering {
  const slug = thread?.id
  const pageProjectDir = useProjectDir()
  const projectDir = scope ? scope.projectDir : pageProjectDir
  const api = scope?.api ?? rpc
  // CHANGE REOPENS AN ANSWERED QUESTION ON THIS SURFACE ONLY. It joins the open ones for staging and
  // sending, and the send is an ordinary answer the server takes as a change (router answerQuestions),
  // so the worker hears nothing until the new answer exists — a Change abandoned changes nothing.
  const [editing, setEditing] = useState<ReadonlyMap<string, RegisteredQuestionView>>(() => new Map())
  const open = thread?.questions ?? []
  const questions = useMemo(
    () => (editing.size === 0 ? open : [...open.filter((q) => !editing.has(q.id)), ...editing.values()]),
    [open, editing],
  )
  // A SECRET's typed value, keyed by question id. In React state and nowhere else: the draft store
  // mirrors into localStorage, which every tab reads and which outlives the browser, and a pasted
  // credential must not outlive the tab in a cache (lib/drafts says so for the typed interaction cards
  // too). The cost is that a reload loses a half-pasted code, which is the right way round for a
  // one-time code.
  const [secrets, setSecrets] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [error, setError] = useState<string>()
  // What this state has sent, by id — kept until the server refuses it, so a question is never staged or
  // sent twice however long the board takes to drop it, and so a surface can grey it where it stood.
  const [sent, setSent] = useState<ReadonlyMap<string, SettledQuestion>>(() => new Map())
  // Sends in flight. Several can be at once now — the human picks the next card while the last one's
  // round-trip is still out — so one mutation's `isPending` no longer says it.
  const [inFlight, setInFlight] = useState(0)
  // THE QUEUE CARD DISSOLVES ON SEND, like every other action on it. Answering is the same commitment as
  // a fenced Send answers or a composer steer — both of which take the card out of the queue the instant
  // the human commits, without waiting on the round-trip (see useLiveAnswering's onSent) — and this was
  // the one send that did not, so a card answered on a loaded machine sat there for the seconds it took
  // the board to catch up, which is the window its answer rendered twice in (2026-09-01). …UNLESS the
  // card still asks something: then it HOLDS its place (see `sendPairs`). Null on the thread page, where
  // there is no card to dismiss.
  const queueDismiss = useContext(QueueDismissContext)
  const sendScope = useContext(SendScopeContext)

  // Picks and text share the draft store, so queue, drawer, fullscreen (in this tab or another) and
  // project remounts all see the same staged answer. Secrets stay strictly in memory outside this
  // subscription.
  const textKeys = useMemo(
    () => (slug ? questions.flatMap((q) => (q.spec.secret ? [] : allPaths(q).flatMap((path) => [
      draftKey.question(projectDir, slug, q.id, path), draftKey.questionPick(projectDir, slug, q.id, path),
    ]))) : []),
    [projectDir, slug, questions],
  )
  const persistedText = useDraftValues(textKeys)
  const pickKeys = useMemo(
    () => (slug ? questions.flatMap((q) => allPaths(q).map((path) => draftKey.questionPick(projectDir, slug, q.id, path))) : []),
    [projectDir, slug, questions],
  )
  const persistedPicks = useDraftValues(pickKeys)
  // Writes read the STORE, not this render's snapshot: two updates in one event must not drop the first.
  // Writes read the STORE (no `from`), not this render's snapshot: two updates in one event must not drop
  // the first. A node with no spec at its path (a stale path) holds no pick.
  const readPick = (q: RegisteredQuestionView, path: string, from?: ReadonlyMap<string, string>): QuestionPick => {
    const spec = questionSpecAt(q.spec, path)
    if (!slug || !spec) return NO_PICK
    const key = draftKey.questionPick(projectDir, slug, q.id, path)
    return decodeQuestionPick(spec, (from ? from.get(key) : draftStore.get(key)) ?? "")
  }
  const writePick = (q: RegisteredQuestionView, path: string, pick: QuestionPick) => {
    const spec = questionSpecAt(q.spec, path)
    if (slug && spec) draftStore.set(draftKey.questionPick(projectDir, slug, q.id, path), encodeQuestionPick(spec, pick))
  }
  /** Drop a question's whole staged answer, picks and text, in one commit. */
  const clearStaged = (q: RegisteredQuestionView) => {
    if (!slug) return
    draftStore.clearMany(allPaths(q).flatMap((path) => [draftKey.question(projectDir, slug, q.id, path), draftKey.questionPick(projectDir, slug, q.id, path)]))
  }
  const answerFor = (q: RegisteredQuestionView, path: string): BlockAnswer => {
    if (q.spec.secret) return { chosen: null, chosenSet: [], text: secrets.get(q.id) ?? "" }
    const pick = readPick(q, path, persistedPicks)
    return {
      chosen: pick.chosen,
      chosenSet: pick.chosenSet,
      text: (slug ? persistedText.get(draftKey.question(projectDir, slug, q.id, path)) : undefined) ?? "",
    }
  }
  const answersOf = (q: RegisteredQuestionView): ReadonlyMap<string, BlockAnswer> =>
    new Map(allPaths(q).map((path) => [path, answerFor(q, path)]))

  // What a send would carry, per question — never one already sent.
  const stagedPairs = questions.flatMap((q) => {
    if (sent.has(q.id) && !editing.has(q.id)) return []
    const built = registeredAnswer(q, answersOf(q))
    return built ? [{ q, answer: built }] : []
  })
  const queryClient = useQueryClient()

  const send = useMutation({
    // The draft keys are captured AT SEND (upstream bd4f96b7): the board push may drop the question
    // before the reply lands, and the current board's questions are then no way to find them.
    mutationFn: async (submission: { answers: QuestionAnswer[]; drafts: Array<{ id: string; keys: string[] }> }) =>
      api.answerQuestions({ slug: slug!, answers: submission.answers }),
    onSuccess: (result, submission) => {
      // The board push removes these rows, so the staged state for them is dead weight. Left behind, it
      // would sit in the tab's draft store, whose reload snapshot keeps only the most recent entries
      // (lib/drafts MAX_ENTRIES), and could push an older, still-live draft out of it.
      for (const id of result.answered) {
        setSecrets((prev) => {
          if (!prev.has(id)) return prev
          const next = new Map(prev)
          next.delete(id)
          return next
        })
        draftStore.clearMany(submission.drafts.find((entry) => entry.id === id)?.keys ?? [])
      }
      // A changed answer has landed: its slot draws the settled card again, with the new answer.
      const landed = new Set(result.answered)
      setEditing((prev) => ([...prev.keys()].some((id) => landed.has(id)) ? new Map([...prev].filter(([id]) => !landed.has(id))) : prev))
    },
    onError: (cause, { answers }) => {
      // The card faded (or greyed) on click; the answer did not land, so put it back rather than leaving
      // the human looking at a queue that quietly swallowed their reply. Same reversal an optimistic
      // Mark-as-done makes when the server declines it.
      queueDismiss?.cancel()
      if (slug && scope) clearSteeredIn(scope.projectId, slug)
      else if (slug) clearSteered(slug)
      // A CHANGE that failed keeps its entry: the card is still open for it (`editing` wins), and the
      // greyed copy under it must not come back as a second card on surfaces that draw `sent` apart.
      const ids = new Set(answers.map((a) => a.questionId).filter((id) => !editing.has(id)))
      setSent((prev) => new Map([...prev].filter(([id]) => !ids.has(id))))
      setError(errorText(cause))
    },
    // Server truth replaces the optimistic settled cards either way: on success it carries the real
    // `settledAt`, and on failure it no longer holds them, which brings the open card back.
    onSettled: () => {
      setInFlight((n) => Math.max(0, n - 1))
      if (slug) void queryClient.invalidateQueries({ queryKey: settledQuestionsKey(slug, scope?.projectId) })
    },
  })
  // THE × TAKES THE QUESTION OFF THE CARD ON CLICK, not on the board read that follows. That read is a
  // poll on the All queues page, and a project still reopening after a server restart is drawn from
  // its LAST poll for up to a minute (AllQueues useLastKnownQueues) — so the dismissal landed on the
  // first click and the question stayed on the card, and every later × was a silent no-op on a row no
  // longer open (2026-10-06, `@logo-design`: "have clicked x multiple times over ~30 seconds"). Back on
  // screen only if the server still lists it open — a refusal — or the request fails.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const undismiss = (id: string) =>
    setDismissed((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  const dismiss = useMutation({
    mutationFn: async (id: string) => api.dismissQuestions({ slug: slug!, ids: [id] }),
    onMutate: (id) => setDismissed((prev) => new Set(prev).add(id)),
    onSuccess: (result, id) => {
      if (result.open.some((q) => q.id === id)) undismiss(id)
    },
    onError: (cause, id) => {
      undismiss(id)
      setError(errorText(cause))
    },
  })
  // THE DEFAULT HOLDS WHILE THE HUMAN IS ON THE CARD. A question that would take its recommended option
  // (`defaultsAt`) is told about every pick, toggle and keystroke — at most once per ENGAGE_PING_MS, well
  // inside the server's grace — so the default cannot fire under someone halfway through answering. A
  // lost ping is not worth an error line: the next interaction sends another.
  // The countdown's × hides it at once, like the question's own × (David 2026-10-08), and it is back
  // only if the request fails.
  // Keyed by question, as the server's turn-off is: any one turned off holds the group (shared
  // threadQuestionDefaults), and questions asked afterwards are a new group with a countdown of its own.
  const [defaultCancelled, setDefaultCancelled] = useState<ReadonlySet<string>>(() => new Set())
  const hold = useMutation({
    mutationFn: async (input: { id: string; action: "engage" | "cancel" }) => api.holdQuestionDefault({ slug: slug!, ...input }),
    onError: (cause, input) => {
      if (input.action !== "cancel") return
      setDefaultCancelled((prev) => {
        const next = new Set(prev)
        next.delete(input.id)
        return next
      })
      setError(errorText(cause))
    },
  })
  const defaulting = questions.filter((q) => q.defaultsAt && !sent.has(q.id) && !dismissed.has(q.id))
  const engagedAt = useRef(new Map<string, number>())
  const engage = (q: RegisteredQuestionView) => {
    if (!slug || !q.defaultsAt) return
    const now = Date.now()
    if (now - (engagedAt.current.get(q.id) ?? 0) < ENGAGE_PING_MS) return
    engagedAt.current.set(q.id, now)
    hold.mutate({ id: q.id, action: "engage" })
  }

  // A secret's settled card never draws the value, not even for the beat before the server's own
  // stored text (where the file went) replaces this.
  const displayed = (pairs: typeof stagedPairs): QuestionAnswer[] =>
    pairs.map(({ q, answer }) => (q.spec.secret ? { ...answer, text: "(secret sent)" } : answer))
  const draftKeysOf = (owner: string, pairs: typeof stagedPairs) =>
    pairs.map(({ q }) => ({ id: q.id, keys: q.spec.secret ? [] : allPaths(q).flatMap((path) => [
      draftKey.question(projectDir, owner, q.id, path), draftKey.questionPick(projectDir, owner, q.id, path),
    ]) }))
  // THE CARD GREYS IN PLACE ON SEND, before the round-trip: the answered question joins the settled
  // list now, and the surface stops drawing the open card for any id that list holds (see
  // withoutSettledQuestions). Waiting for the server instead left a beat where the open card had gone
  // with the board push and the settled one had not arrived — the card blinking out and back. Both
  // sends take it: this state's own (`sendPairs`) and the prompt box's (`take`).
  const settleOptimistically = (owner: string, pairs: typeof stagedPairs) => {
    const key = settledQuestionsKey(owner, scope?.projectId)
    void queryClient.cancelQueries({ queryKey: key })
    const settledAt = new Date().toISOString()
    const ids = new Set(pairs.map((pair) => pair.q.id))
    const shown = displayed(pairs)
    const settled = pairs.map(({ q }, i): SettledQuestion => ({ id: q.id, spec: q.spec, askedAt: q.askedAt, settledAt, pending: true, answer: shown[i]! }))
    queryClient.setQueryData<SettledQuestion[]>(key, (prev) => [...(prev ?? []).filter((s) => !ids.has(s.id)), ...settled])
    setSent((prev) => new Map([...prev, ...settled.map((s) => [s.id, s] as const)]))
  }

  const sendPairs = (pairs: typeof stagedPairs, then?: () => void) => {
    if (!slug || pairs.length === 0) return
    setError(undefined)
    const ids = new Set(pairs.map((pair) => pair.q.id))
    // Local truth FIRST, then the network — the ordering every other send on this card obeys, and the
    // whole of what "the card goes away when I answer it" means on a machine under load. But a card that
    // still asks something HOLDS (David 2026-09-29: "the remaining questions … should stay there"):
    // the worker starts on this answer and leaves the queue for it, and the card stays in its place, live,
    // with the answered question greyed and the rest answerable, until the last one is sent.
    const stillOpen = open.some((q) => !ids.has(q.id) && !sent.has(q.id)) || [...editing.keys()].some((id) => !ids.has(id))
    if (stillOpen) queueDismiss?.hold?.()
    else queueDismiss?.dismiss()
    // …AND THE RAIL ROW GOES TO WORK WITH IT. Every answer wakes the worker (the scheduler delivers it),
    // so this is a steer in all but name, and it takes the steer's overlay: without it the row dropped
    // its question mark on the board push, sat in the queue wearing the at-rest ellipsis, and only moved
    // to the running band once the delivery landed (lib/steering.ts).
    // On another project's card the record is that project's (markSteeredIn): a bare slug there would
    // set the page project's thread of the same name to work.
    if (scope) markSteeredIn(scope.projectId, slug)
    else markSteered(slug)
    settleOptimistically(slug, pairs)
    setInFlight((n) => n + 1)
    // `mutateAsync`, not per-call callbacks: the queue card dissolves on this very click and unmounts,
    // and a mutate()-scoped onSuccess is dropped with the observer — the reply riding `then` with it.
    send.mutateAsync({ answers: pairs.map((pair) => pair.answer), drafts: draftKeysOf(slug, pairs) }).then(() => then?.(), () => {})
  }
  const commit = (q: RegisteredQuestionView) => sendPairs(stagedPairs.filter((pair) => pair.q.id === q.id))
  // THE PROMPT BOX'S SEND TAKES THEM (lib/sendScope, upstream 59089c92). The same local truth as
  // `sendPairs` — the cards grey in place and are never staged twice — minus what that send already does
  // for itself: it dissolves the queue card, marks the row steered, and its own failure says why a refused
  // send came back. The server settles these answers and sends them above the typed note, as one turn.
  const take = (): RegisteredTake | null => {
    if (!slug) return null
    // Never a reopened answer still standing as it was: sending it would re-send the answer it had.
    const pairs = stagedPairs.filter((pair) => !editing.has(pair.q.id) || answerKey(pair.answer) !== changedFrom.current.get(pair.q.id))
    if (pairs.length === 0) return null
    const drafts = draftKeysOf(slug, pairs)
    const ids = new Set(pairs.map((pair) => pair.q.id))
    const settle = () => void queryClient.invalidateQueries({ queryKey: settledQuestionsKey(slug, scope?.projectId) })
    const forget = () => {
      setSecrets((prev) => {
        if (!pairs.some(({ q }) => prev.has(q.id))) return prev
        const next = new Map(prev)
        for (const { q } of pairs) next.delete(q.id)
        return next
      })
      draftStore.clearMany(drafts.flatMap((entry) => entry.keys))
      setEditing((prev) => ([...prev.keys()].some((id) => ids.has(id)) ? new Map([...prev].filter(([id]) => !ids.has(id))) : prev))
    }
    return {
      answers: pairs.map((pair) => pair.answer),
      display: displayed(pairs),
      onOptimistic: () => {
        setError(undefined)
        settleOptimistically(slug, pairs)
      },
      onSuccess: () => { forget(); settle() },
      // Server truth replaces the optimistic settled cards either way. Refused outright, the questions
      // are still open there and the cards come back with their staged answers intact; kept as a
      // failed send, the questions ARE settled and the failed bubble carries the words.
      onRollback: (kept) => {
        if (kept) forget()
        else setSent((prev) => new Map([...prev].filter(([id]) => !ids.has(id) || editing.has(id))))
        settle()
      },
    }
  }
  const submit = (then?: () => void) => {
    if (!then && sendScope?.composer.run()) return
    sendPairs(stagedPairs, then)
  }
  // THE GROUP FOOTER IS "DONE WITH THIS GROUP" (David 2026-10-08: blank questions kept the card waiting
  // after it). What is staged goes as answered, and every question still blank goes beside it as
  // `skipped`, so the worker hears everything at once and asks again whatever still matters. A typed
  // reply carrying staged answers (`submit`) leaves the blanks open: its box promises they stay.
  // SCOPED TO ONE STACK'S QUESTIONS: the thread page hangs each ask after the rest that asked it, and a
  // footer under the newest must not skip a question still open further up.
  const submitGroup = (ids: ReadonlySet<string>) => sendPairs([
    // Never a reopened answer: Change is finished by that card's own Send or Cancel, and the group
    // button sending it as it stands would re-send the answer it already had.
    ...stagedPairs.filter((pair) => ids.has(pair.q.id) && !editing.has(pair.q.id)),
    ...questions.flatMap((q) =>
      // `sent` covers a reopened answer too: left blank, it keeps the answer it has rather than skipping.
      !ids.has(q.id) || sent.has(q.id) || dismissed.has(q.id) || stagedPairs.some((pair) => pair.q.id === q.id)
        ? []
        : [{ q, answer: { questionId: q.id, question: q.spec.question, chosen: [], skipped: true } }]),
  ])

  // A PICK THAT COMPLETES ITS QUESTION SENDS IT (David 2026-09-29: "the agent should receive the
  // answer to one question at a time so it can start working"). Before 2026-09-29 a pick sent only once
  // EVERY owed question was answered, and before that only Send answers sent at all — so the worker sat
  // idle while the human read the rest.
  //
  // Only a SINGLE-choice pick arms it. That click is the whole answer; a multi toggle is one of several,
  // and a keystroke is half a word, so neither can say "done" — Enter (see `enter`) and Send answers stay
  // the send for those. Read on the render AFTER the pick, because completeness includes the follow-ups
  // the pick just opened: a pick that opens some waits for them, and the pick that answers the last one
  // sends the whole question. And it holds off while the thread's prompt box has a draft: that human is
  // mid-note, and their Enter sends both (ThreadComposerBox) — the card's own Send says it is held.
  // A LAYOUT effect, so the pick and its send paint as one frame: after paint, the card's Send flashed
  // up for the frame between them.
  const autoSend = useRef<string | null>(null)
  useLayoutEffect(() => {
    const id = autoSend.current
    if (id === null) return
    autoSend.current = null
    const q = questions.find((entry) => entry.id === id)
    if (!q || (sent.has(q.id) && !editing.has(q.id)) || !questionComplete(q.spec, answersOf(q))) return
    const drafting = slug ? (draftStore.get(draftKey.followUp(projectDir, slug, thread?.sessionId)) ?? "").trim() !== "" : false
    if (!drafting) commit(q)
  })

  const enter = (q: RegisteredQuestionView, grid: HTMLElement) => {
    // This question's own cards first — the root, then the follow-ups its pick opened, in order.
    const article = grid.closest<HTMLElement>("[data-question-id]")
    const own = article ? [...article.querySelectorAll<HTMLElement>("[data-answerable-question]")] : [grid]
    const nextOwn = own.slice(own.indexOf(grid) + 1).find((node) => node.dataset.answered === "false")
    if (nextOwn) {
      focusQuestionNode(nextOwn)
      return
    }
    // None left: send it, and go on to the next unanswered question of the set — found BEFORE the send,
    // which greys this one out from under the walk. After this question first, then wrapping.
    const set = grid.closest("[data-question-set]")
    const others = set ? [...set.querySelectorAll<HTMLElement>("[data-answerable-question]")].filter((node) => !article?.contains(node)) : []
    const after = others.filter((node) => article && article.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
    const next = [...after, ...others.filter((node) => !after.includes(node))].find((node) => node.dataset.answered === "false")
    commit(q)
    if (next) focusQuestionNode(next)
  }

  // The settled list this thread's answered cards draw from — subscribed, never fetched from here (the
  // surface's useSettledQuestions decides when). The real fetcher all the same: a shared query refetches
  // with whichever observer's options it holds last.
  const settledList = useQuery({
    queryKey: settledQuestionsKey(slug ?? "", scope?.projectId),
    queryFn: async (): Promise<SettledQuestion[]> => (await api.threadSettledQuestions({ slug: slug! })).questions,
    enabled: false,
    refetchOnWindowFocus: false,
  }).data ?? NO_SETTLED
  // The set being moved through: every ask from the oldest still open on, or the newest ask once all of
  // it is answered. ISO stamps of one clock, so they compare as strings.
  const newestAsk = [...open, ...settledList].reduce((max, q) => (q.askedAt > max ? q.askedAt : max), "")
  const changeFrom = open.reduce((min, q) => (q.askedAt < min ? q.askedAt : min), newestAsk)
  // Never a SENT secret: reopening it would stage the stored placeholder, and the value itself is gone by
  // design. A skipped one can still be answered after all.
  const canChange = (s: SettledQuestion) =>
    Boolean(slug) && (!s.spec.secret || s.answer.skipped === true) && s.askedAt >= changeFrom && settledList.some((entry) => entry.id === s.id)
  const forget = (id: string) => {
    const q = editing.get(id)
    if (q) clearStaged(q)
  }
  // The answer each reopened question opened on, so its Send waits for an actual change.
  const changedFrom = useRef(new Map<string, string>())
  const change = (s: SettledQuestion) => {
    if (!slug) return
    setError(undefined)
    // OPENS ON THE ANSWER IT REPLACES, so changing one pick of several is one click and the rest stand.
    const staged = stagedFromAnswer(s.spec, s.answer)
    const view: RegisteredQuestionView = { id: s.id, spec: s.spec, askedAt: s.askedAt }
    clearStaged(view)
    draftStore.setMany(Object.fromEntries([...staged].flatMap(([path, pick]) => [
      [draftKey.question(projectDir, slug, s.id, path), pick.text],
      [draftKey.questionPick(projectDir, slug, s.id, path), (() => {
        const spec = questionSpecAt(s.spec, path)
        return spec ? encodeQuestionPick(spec, { chosen: pick.chosen, chosenSet: pick.chosenSet ?? [] }) : ""
      })()],
    ])))
    setEditing((prev) => new Map(prev).set(s.id, view))
    changedFrom.current.set(s.id, answerKey(s.answer))
  }
  const keep = (id: string) => {
    forget(id)
    setEditing((prev) => new Map([...prev].filter(([key]) => key !== id)))
  }

  return {
    slug,
    answerFor,
    answersOf,
    onChip: (q, path, isMulti, optIdx) => {
      engage(q)
      // SINGLE: picking a chip makes it the answer; re-picking toggles off — mirroring both other
      // producers. The typed draft is never cleared (maintainer 2026-09-02): it stays in the box as an
      // unselected draft, and registeredAnswer submits the chip while one is chosen (the box taking
      // focus clears it via onText below).
      const spec = questionSpecAt(q.spec, path)
      if (!spec || q.spec.secret || !spec.options?.[optIdx]) return
      // Read the store at the event, not the last render: rapid toggles must compose, including when
      // another mounted copy of this question just staged a pick.
      const pick = readPick(q, path)
      if (isMulti) {
        const set = pick.chosenSet.includes(optIdx)
          ? pick.chosenSet.filter((v) => v !== optIdx)
          : [...pick.chosenSet, optIdx]
        writePick(q, path, { ...pick, chosenSet: set })
      } else {
        if (pick.chosen !== optIdx) autoSend.current = q.id
        writePick(q, path, { ...pick, chosen: pick.chosen === optIdx ? null : optIdx })
      }
    },
    onText: (q, path, isMulti, text) => {
      if (!slug) return
      engage(q)
      if (q.spec.secret) {
        setSecrets((prev) => (prev.get(q.id) === text ? prev : new Map(prev).set(q.id, text)))
        return
      }
      draftStore.set(draftKey.question(projectDir, slug, q.id, path), text)
      // SINGLE: the free-text box taking over — a keystroke OR just focusing it — drops the chosen chip,
      // as the fence producer does. The card's onFocus calls this with the text unchanged for exactly
      // that reason, so writing the draft alone left the chip lit beside a focused box (2026-08-28).
      if (!isMulti) {
        const pick = readPick(q, path)
        if (pick.chosen !== null) writePick(q, path, { ...pick, chosen: null })
      }
    },
    dismiss: (id) => dismiss.mutate(id),
    dismissing: dismiss.isPending,
    dismissed,
    cancelDefault: () => {
      setDefaultCancelled((prev) => new Set([...prev, ...defaulting.map((q) => q.id)]))
      // Every one, not just the first: the server would hold the group on any one of them, but the
      // worker may `unask` that one and the others must not start counting down again.
      for (const q of defaulting) hold.mutate({ id: q.id, action: "cancel" })
    },
    defaultCountdown: !defaulting.some((q) => defaultCancelled.has(q.id)) && defaulting.length > 0 ? { ownerId: defaulting[defaulting.length - 1]!.id, count: defaulting.length } : undefined,
    commit,
    submit,
    take,
    submitGroup,
    // A REOPENED answer is unsent only once it differs from the one it replaces: opened on that answer,
    // "Send new answer" beside it would offer to send the same thing again.
    unsent: (q) => stagedPairs.some((pair) => pair.q.id === q.id && (!editing.has(q.id) || answerKey(pair.answer) !== changedFrom.current.get(q.id))),
    settled: settledList,
    enter,
    sent,
    editing,
    canChange,
    change,
    keep,
    staged: stagedPairs.length,
    sending: inFlight > 0,
    error,
  }
}

/** How often a card re-reports the human working on it. Well under QUESTION_DEFAULT_ENGAGED_GRACE_MS,
 *  so steady typing keeps the deadline pushed out. */
const ENGAGE_PING_MS = 30_000

// ---- ANSWERED questions: the card stays where it stood, greyed, showing only the answer ----

/** An answered registration as the transcript draws it. `pending` marks one this tab just sent and has
 *  not yet read back — see lib/settledQuestions. */
export type SettledQuestion = SettledQuestionView & { pending?: true }
const NO_SETTLED: readonly SettledQuestion[] = []
/** The cache entry a thread's answered questions live under. A thread of the PAGE's project keys by slug
 *  (the page's query scope says whose); a thread drawn on another project's queue card names its project
 *  in the key (`ofProject`, lib/queryKeyScope.ts), since on All projects the page's scope is not the
 *  card's and two projects' same-named threads would otherwise share one list. The answering state writes
 *  its optimistic entries through the same function, so the card and its stacks always meet. */
export const settledQuestionsKey = (slug: string, projectId?: string) =>
  projectId === undefined ? (["settledQuestions", slug] as const) : (["ofProject", projectId, "settledQuestions", slug] as const)

/** The thread's answered questions. Read per thread rather than off the board (see the shared
 *  SettledQuestionView), and re-read on the one board event that can add to it: a question leaving the
 *  OPEN list — answered here, in another tab, or on the queue card. A withdrawal or a dismissal re-reads
 *  too, and finds nothing new; that costs one indexed SELECT.
 *
 *  `scope` reads them through the thread's own project (the queue card's, like RegisteredAnsweringScope),
 *  and `enabled: false` holds the read for a surface that has nothing to place them in yet — the queue
 *  card reads them only once it is reading the transcript they are placed in. Both absent on the drawer. */
export function useSettledQuestions(
  thread: ThreadView | undefined,
  opts: { scope?: { api: Pick<Api, "threadSettledQuestions">; projectId: string }; enabled?: boolean } = {},
): readonly SettledQuestion[] {
  const slug = thread?.id
  const { scope, enabled = true } = opts
  const api = scope?.api ?? rpc
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: settledQuestionsKey(slug ?? "", scope?.projectId),
    queryFn: async (): Promise<SettledQuestion[]> => (await api.threadSettledQuestions({ slug: slug! })).questions,
    enabled: Boolean(slug) && enabled,
    refetchOnWindowFocus: false,
  })
  const openIds = (thread?.questions ?? []).map((q) => q.id).join(" ")
  const previous = useRef(openIds)
  useEffect(() => {
    const before = previous.current
    previous.current = openIds
    if (!slug || before === openIds) return
    const now = new Set(openIds.split(" "))
    if (before.split(" ").some((id) => id && !now.has(id))) void queryClient.invalidateQueries({ queryKey: settledQuestionsKey(slug, scope?.projectId) })
  }, [openIds, queryClient, slug, scope?.projectId])
  return query.data ?? NO_SETTLED
}

const NO_OPEN: readonly RegisteredQuestionView[] = []

/** The thread's OPEN questions minus every one the settled list already holds, so one question never
 *  draws twice: in the beat between Send and the board push the row is still open on the board while
 *  its settled card is already drawn. For the question cards ONLY — everything else keeps reading the
 *  board's own `thread.questions`, because the rows are still open there until that push, and the push
 *  is what also brings `answersInFlight`: a surface that saw no questions AND nothing in flight in that
 *  beat would draw the "Rested without a sign-off" card in the hole. The board's own array when nothing
 *  is taken, so a memo keyed on it does not churn. */
export function openQuestionsOf(thread: ThreadView | undefined, settled: readonly SettledQuestion[]): readonly RegisteredQuestionView[] {
  const open = thread?.questions ?? NO_OPEN
  if (settled.length === 0 || open.length === 0) return open
  const ids = new Set(settled.map((s) => s.id))
  return open.some((q) => ids.has(q.id)) ? open.filter((q) => !ids.has(q.id)) : open
}

/** ONE answered registration, in the slot its open card filled: the same card, the same branch rule,
 *  greyed, and carrying only what was picked or typed. Read-only — the answer has been sent. */
export function SettledQuestionCard({ s, wrap, answering: given }: { s: SettledQuestion; wrap?: boolean; answering?: RegisteredAnswering }) {
  const shared = useContext(RegisteredAnsweringContext)
  const a = given ?? shared
  const nodes = useMemo(() => settledQuestionNodes(s.spec, s.answer), [s.spec, s.answer])
  // REOPENED WITH CHANGE: the open card, in this same slot, until the new answer lands or Keep.
  const reopened = a?.editing.get(s.id)
  if (reopened && a) return <RegisteredQuestionCard q={reopened} answering={a} />
  const changeable = a?.canChange(s) === true
  const skipped = s.answer.skipped === true
  const card = (node: (typeof nodes)[number]) => (
    <QuestionBlockCard
      key={node.path}
      question={node.question}
      // THE TITLE SAYS IT WENT. "Question" on a greyed card read as a question gone inert, not one
      // answered, so whether a click had sent anything was a guess (David 2026-10-08). Never "Select
      // multiple" either: that is an instruction nobody can act on any more. A secret says it was sent,
      // never what it was.
      label={node.depth > 1 ? "Follow-up" : skipped ? "Skipped" : node.question.secret ? "Secret sent" : "Answered"}
      settled={node.settled}
      wrap={wrap}
      // CHANGE, on the root's title row: the human moving through a set can take an answer back
      // (David 2026-10-08). Only on the set being answered now — see canChange.
      aside={node.depth === 1 && changeable && a ? (
        <button
          type="button"
          data-change-answer
          onClick={() => a.change(s)}
          className={TITLE_TEXT_BUTTON}
        >
          {/* A skipped question has no answer to change; this answers it after all. */}
          {skipped ? "Answer" : "Change"}
        </button>
      ) : undefined}
    />
  )
  const branch = nodes.slice(1)
  return (
    <article data-question-id={s.id} data-settled-question aria-label="Answered question" className={`${QUESTION_CONTAINER} flex min-w-0 flex-col gap-2 opacity-60`}>
      {card(nodes[0])}
      {branch.length > 0 && (
        <div className={`${BRANCH_RULE} flex flex-col gap-2`}>
          {branch.map((node) => (
            <div key={node.path} className={node.depth > 2 ? BRANCH_RULE : undefined}>
              {card(node)}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

// A REGISTERED QUESTION IS ITS OWN SIZE CONTAINER, so its follow-up branch can tighten to the width the
// card actually has (a 300px VS Code sidebar's drawer gives it ~252px, a phone's ~330, the desktop
// drawer's 672). Each level of the branch cost 24px of indent (`ml-3 pl-3`) on top of the nested card's
// own 32px of padding, leaving a depth-3 follow-up ~160px of label at 300. Under 24rem of card the rule
// keeps its place and the indent halves (6px + 8px); anywhere wider it is the desktop's 12 + 12.
const QUESTION_CONTAINER = "@container/question"
/** A word on a card's title row — Change, Answer, Cancel. A WORD, never a second ×: the dismiss × owns
 *  that corner, and a × that meant "keep the earlier answer" in the same spot read as dismissing it. */
const TITLE_TEXT_BUTTON = "icon-hover-outline -mx-1.5 -my-0.5 rounded-md px-1.5 py-0.5 text-[12px] leading-5 text-muted-70 outline-none transition-colors hover:bg-elevated hover:text-fg"
/** The send buttons — a question's own, and the group's. */
const SEND_BUTTON = "button-outline rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
const QUIET_BUTTON = "rounded-md border border-border px-3 py-1.5 text-[12px] font-medium text-fg/90 outline-none transition-all hover:bg-elevated active:scale-95 disabled:opacity-30"
const BRANCH_RULE = "ml-3 border-l border-border pl-3 @max-[24rem]/question:ml-1.5 @max-[24rem]/question:pl-2"

/** A follow-up the human's own pick just opened. It grows the card BELOW the fold of a drawer's transcript
 *  — at a 300px VS Code sidebar under the floating "Jump to latest" control, over its "Something else…"
 *  rows — so it reveals itself, clear of that control, in the drawer's transcript only
 *  (lib/drawerReveal.ts). Only a node that mounts AFTER its card did (`reveal`): the branch a card opens
 *  with is where the human left it, and a card re-mounted by the virtualizer must not drag the transcript. */
function BranchNode({ reveal, className, children }: { reveal: ((el: HTMLElement) => void) | null; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  // Mount-only on purpose: `reveal` is read at the moment the node appears, never again. It only queues
  // the node; the card reveals everything one pick opened as one span (RegisteredQuestionCard).
  useEffect(() => {
    if (reveal && ref.current) reveal(ref.current)
  }, [])
  return <div ref={ref} className={className}>{children}</div>
}

/** Several answered registrations anchored after one message. */
export function SettledQuestionStack({ questions, wrap, className = "" }: { questions: readonly SettledQuestion[]; wrap?: boolean; className?: string }) {
  if (questions.length === 0) return null
  return (
    <section data-settled-questions aria-label={`${questions.length} answered question${questions.length === 1 ? "" : "s"}`} className={`flex min-w-0 flex-col gap-3 ${className}`}>
      {questions.map((s) => <SettledQuestionCard key={s.id} s={s} wrap={wrap} />)}
    </section>
  )
}

/** Mount ONCE per surface that draws registered cards in more than one place. Must sit INSIDE the
 *  surface's QueueDismissContext, which the send reads. */
export function RegisteredAnsweringProvider({ thread, scope, children }: { thread: ThreadView | undefined; scope?: RegisteredAnsweringScope; children: ReactNode }) {
  const answering = useRegisteredAnswering(thread, scope)
  return <RegisteredAnsweringContext.Provider value={answering}>{children}</RegisteredAnsweringContext.Provider>
}

/** ONE registered question: its root card and the follow-up branch the staged answer opens. Reads the
 *  surface's shared state through context, or the one a stack hands it. */
export function RegisteredQuestionCard({ q, answering: given }: { q: RegisteredQuestionView; answering?: RegisteredAnswering }) {
  const shared = useContext(RegisteredAnsweringContext)
  const phone = usePhoneQuestions()
  // False through the card's first render, true after: a follow-up that mounts later was opened by a pick.
  // Those queue themselves in `opened` as they mount, and the effect below — after every child's, in the
  // same commit — reveals them together and clears the queue.
  const mounted = useRef(false)
  const opened = useRef<HTMLElement[]>([])
  useEffect(() => {
    mounted.current = true
  }, [])
  useEffect(() => {
    if (opened.current.length === 0) return
    revealInDrawerTranscript(opened.current)
    opened.current = []
  })
  const a = given ?? shared
  if (!a || !a.slug) return null
  // On the phone thread page the card is a reading surface; the sheet answers it (PhoneQuestionCards).
  const group = a.defaultCountdown
  const countdown = q.defaultsAt && group?.ownerId === q.id
    ? <DefaultCountdown at={q.defaultsAt} to={group.count === 1 ? q.defaultsTo : undefined} count={group.count} onCancel={a.cancelDefault} />
    : null
  if (phone) return <>
    <CompactQuestionList questions={[q]} />
    {countdown}
  </>
  const nodes = liveQuestionNodes(q.spec, a.answersOf(q))
  const editing = a.editing.has(q.id)
  const card = (node: (typeof nodes)[number]) => (
    <QuestionBlockCard
      key={node.path}
      question={node.question}
      // Named for what it IS, so the relationship survives even where the rule is subtle. A reopened
      // answer says so: it looks like any open question, and its Cancel only makes sense as an edit's.
      label={node.depth > 1 ? "Follow-up" : editing ? "Changing answer" : undefined}
      // The ×, on the ROOT card's title row only — one registration is one thing to dismiss, and a
      // follow-up cannot be declined separately from the answer that opened it. It is NEVER offered on
      // a `danger` question: a generic close icon is not consent for something irreversible, and
      // declining is a real option INSIDE that question. The server refuses one too, so this is the
      // affordance and not the rule.
      aside={node.depth === 1 && editing ? (
        // A REOPENED answer's Cancel puts the old answer back: nothing was sent, so there is nothing to undo.
        <button
          type="button"
          data-keep-answer
          title="Keep the earlier answer"
          onClick={() => a.keep(q.id)}
          className={TITLE_TEXT_BUTTON}
        >
          Cancel
        </button>
      ) : node.depth === 1 && !q.spec.danger ? (
        <button
          type="button"
          data-dismiss-question
          aria-label="Dismiss this question"
          title="Dismiss — let the worker decide"
          disabled={a.dismissing}
          onClick={() => a.dismiss(q.id)}
          // PLACED BY CONSTRUCTION, not by a fitted constant. `p-1 -m-1` cancels exactly, so the
          // button's layout box is the bare 16px svg while its hit area stays 24px; at 16px lucide's X
          // paints 8px of ink centred in its box, and `card-icon-offset` centres that ink on the
          // title's cap block, with nothing to re-measure when the type scale moves.
          // Hand-placed at `-my-1` with a 13px glyph first: the x rode 2.40px above where the offset
          // now puts it. (It shared the corner with the card's HelpCircle kind glyph until 2026-08-31,
          // when the glyph was dropped — a full-strength decoration beside the muted control read as
          // the actionable thing — so the × is the corner mark now.)
          //
          // `flex` is load-bearing: a button is inline-block by default, so inside the head's
          // `leading-6` aside span it sits on that span's BASELINE — which moves with the font and put
          // the x 1.00px high under sans while reading 0.00 under mono. A block-level box has no
          // baseline to sit on, and both settings then measure 0.00.
          //
          // HORIZONTALLY the trim is DEEPER than the padding, because lucide's X paints only 8 of its
          // 16 box px: `-mx-2` collapses the padding AND that inset, so the layout box IS the ink box
          // — which now lands the ×'s ink flush on the card's right content edge (the p-4 inset),
          // where the dropped glyph's ink sat 1.33px shy of it.
          className="icon-hover-outline card-icon-offset -mx-2 -my-1 flex rounded-md p-1 text-muted-70 outline-none transition-colors hover:bg-elevated hover:text-fg disabled:opacity-40"
        >
          <X size={16} />
        </button>
      ) : undefined}
      interactive={{
        answer: a.answerFor(q, node.path),
        onChip: (optIdx) => a.onChip(q, node.path, node.spec.kind === "multi", optIdx),
        onText: (text) => a.onText(q, node.path, node.spec.kind === "multi", text),
        onSubmit: () => a.submit(),
        onEnter: (grid) => a.enter(q, grid),
      }}
      // THIS QUESTION'S OWN SEND, on its last card, while it holds something nothing has sent: a multi's
      // toggles, typed text, a branch partly answered, a pick a draft in the reply box is holding. A
      // single pick needs none — it sends itself — so the button is the visible difference between
      // "picked" and "sent", which until 2026-10-08 only Enter knew. It sends this question alone,
      // exactly as Enter does, and sits INSIDE the card so it never reads as the group's button below.
      footer={node.path === nodes[nodes.length - 1]!.path && a.unsent(q) ? (
        <button type="button" data-send-question disabled={a.sending} onClick={() => a.commit(q)} onMouseDown={(e) => e.preventDefault()} className={SEND_BUTTON}>
          {editing ? "Send new answer" : "Send answer"}
        </button>
      ) : undefined}
    />
  )
  // THE WHOLE BRANCH SITS BEHIND ONE CONTINUOUS RULE, opened by the first follow-up and closed by the
  // last — everything below the root belongs to the single option that was taken. A rule per card (the
  // first cut) drew that one branch as a stack of unrelated indents, because the article's own gap broke
  // the line between every pair. Depth 3 nests its own rule inside this one, which is where the tree
  // stops (ASK_MAX_DEPTH).
  const branch = nodes.slice(1)
  return (
    <article data-question-id={q.id} className={`${QUESTION_CONTAINER} flex min-w-0 flex-col gap-2`}>
      {card(nodes[0])}
      {branch.length > 0 && (
        <div className={`${BRANCH_RULE} flex flex-col gap-2`}>
          {branch.map((node) => (
            <BranchNode key={node.path} reveal={mounted.current ? (el) => opened.current.push(el) : null} className={node.depth > 2 ? BRANCH_RULE : undefined}>
              {card(node)}
            </BranchNode>
          ))}
        </div>
      )}
      {countdown}
    </article>
  )
}

/** THE DEFAULT'S COUNTDOWN — a caption under the card, not chrome on it: the card's own title-row × is
 *  the dismiss, and a second × beside it would read as the same control. Minutes only, on the page's
 *  30s clock (a ticking seconds digit would pull the eye off the question it sits under); `<1m` for the
 *  last minute, as the shell-budget reading spells it. Its Cancel turns the default off for the group. */
function DefaultCountdown({ at, to, count, onCancel }: { at: string; to?: string; count: number; onCancel: () => void }) {
  const now = useNowMs()
  const left = Date.parse(at) - now
  const reading = left < 60_000 ? "<1m" : `${Math.ceil(left / 60_000)}m`
  return (
    // Cancel is the caption's own handle, a word set off by the run of space a word gap is; measured in
    // the optical pass that landed it (2026-10-08). Vertically `items-center` — left alone.
    <div data-question-default className="flex items-center px-4 text-[12px] leading-4 text-muted-70">
      {/* Short enough to stay on one line beside its Cancel in a 380px card; the tooltip says the rest. */}
      {/* `to` names a FALLBACK: the recommendation acts outside this machine, so the default takes the
          first option that does not, and the countdown must not claim it takes the recommendation. */}
      {to ? (
        <span className="min-w-0 truncate" title={`Unless it is answered first. The recommended option is never picked for the human: it acts outside this machine.`}>
          Picks “{to}” in {reading}
        </span>
      ) : (
        <span title="Unless they are answered first">{count === 1 ? "Picks the recommended option" : `Picks all ${count} recommended options`} in {reading}</span>
      )}
      {/* A WORD, not the × it was until 2026-10-08: under a card whose own corner × dismisses the
          question, a second × read as another dismiss rather than "don't pick for me". */}
      <button
        type="button"
        data-cancel-question-default
        title="Keep waiting for an answer"
        onClick={onCancel}
        className="icon-hover-outline -my-0.5 ml-0.5 rounded-md px-1.5 py-0.5 text-fg/80 outline-none transition-colors hover:bg-elevated hover:text-fg"
      >
        Cancel
      </button>
    </div>
  )
}

export function RegisteredQuestionStack({
  thread,
  questions: only,
  inFlight = null,
  keepAnswered = false,
  className = "",
}: {
  thread: ThreadView | undefined
  // WHICH of the thread's open questions this mount draws. Every surface hangs a question after the REST
  // THAT CLAIMS IT rather than at the transcript's tail (lib/questionAnchor questionsByAnchor), so one
  // thread can have several of these mounted at different depths — each handed its own group.
  questions?: readonly RegisteredQuestionView[]
  // THE ANSWER ALREADY SENT AND NOT YET ON SCREEN ANYWHERE ELSE — the rows of `thread.answersInFlight`
  // the transcript is not already drawing (lib/answersMessage.unrenderedAnswers). Passed IN rather than
  // read off the thread here, because deciding it needs the transcript this stack is pinned beside, and
  // because only ONE mount may draw it: the answer is the human's newest turn and belongs at the tail
  // however deep the questions themselves sit. An anchored mount simply omits it.
  inFlight?: PairedAnswer[] | null
  // KEEP EACH ANSWERED QUESTION IN ITS SLOT, greyed, after the board has dropped it — for a surface that
  // draws nothing else of the answer: the queue card, which now HOLDS while it still asks something
  // (useRegisteredAnswering sendPairs). Without it the answered card left the stack on the board push
  // and every card under it moved up under the human's cursor. The thread page does not want it: it
  // draws the greyed card itself, from the settled list, at the rest it was answered at.
  keepAnswered?: boolean
  className?: string
}) {
  const slug = thread?.id
  // A provider above this stack owns the state; without one, this stack does (a surface that draws only
  // one stack has no reason to mount the provider).
  const shared = useContext(RegisteredAnsweringContext)
  const own = useRegisteredAnswering(shared ? undefined : thread)
  const a = shared ?? own
  const offered = only ?? thread?.questions ?? []
  const listed = a.dismissed.size > 0 ? offered.filter((q) => !a.dismissed.has(q.id)) : offered
  // Every question this stack has drawn, in the order it drew them, so one answered and since dropped by
  // the board keeps its slot (`keepAnswered`) — and a question asked since joins at the bottom.
  const drawn = useRef<readonly RegisteredQuestionView[]>([])
  let questions: readonly RegisteredQuestionView[] = listed
  if (keepAnswered) {
    const live = new Map(listed.map((q) => [q.id, q]))
    const kept = drawn.current.flatMap((q) => (live.has(q.id) ? [live.get(q.id)!] : a.sent.has(q.id) || a.editing.has(q.id) ? [q] : []))
    questions = [...kept, ...listed.filter((q) => !kept.some((k) => k.id === q.id))]
    drawn.current = questions
  }
  const phone = usePhoneQuestions()
  // The surface's prompt box sends what is staged (lib/sendScope, upstream 59089c92), so the group's
  // footer stands down there unless it would do what that Send cannot: skip the blank questions.
  const promptBoxSends = usePromptBoxSends()
  const finish = groupFinish(questions, a, promptBoxSends)

  // THE ANSWER, ALREADY SENT AND NOT YET IN THE WORKER'S HANDS. Answering stores the row; a wake hands
  // it over a moment later (deliberately — an answer given while the worker's process is down has to
  // survive the gap). In between, the question card is gone and the delivered turn has not arrived, so
  // this slot went EMPTY and the thread — at rest, with nothing registered any more — drew the residual
  // "Rested without a sign-off" card in the hole (maintainer 2026-08-27: "a little card that, for like
  // 5+ seconds, just says that the thread rested without a sign-off before it shows up my answer").
  //
  // The board composes the bytes the delivery will carry, and the caller parses them with the reader the
  // chat uses on the landed turn — so the in-flight card and the real one are the SAME card and the swap
  // is invisible. Dimmed while it is in flight, exactly like an optimistic follow-up bubble. The caller
  // also decides when it has become a SECOND copy of a card the transcript is already drawing, which is
  // the whole reason the rows arrive as a prop rather than off the thread — see unrenderedAnswers.
  if (!slug || questions.length === 0) {
    if (!slug || !inFlight?.length) return null
    return (
      <section data-answers-in-flight aria-label="Your answer, on its way to the worker" className={`flex min-w-0 flex-col items-end ${className}`}>
        <AnswersCard answers={inFlight} queued />
      </section>
    )
  }

  if (phone) {
    return (
      <section
        data-registered-questions
        aria-label={`${questions.length} question${questions.length === 1 ? "" : "s"} waiting for an answer`}
        className={`flex min-w-0 flex-col gap-3 ${className}`}
      >
        <CompactQuestionList questions={questions} />
        {/* The sheet closes on Send, so a refusal has to surface HERE, beside the questions it restored. */}
        {a.error && <div role="alert" className="break-words text-[13px] leading-snug text-danger-soft">{a.error}</div>}
        {a.sending && <div role="status" aria-live="polite" className="text-[13px] leading-snug text-muted">Sending…</div>}
      </section>
    )
  }

  return (
    <section
      data-registered-questions
      // The batch a card's Enter walks before it sends (QuestionBlockCard advanceOrSubmit).
      data-question-set
      aria-label={(() => {
        const waiting = questions.filter((q) => !a.sent.has(q.id) || a.editing.has(q.id)).length
        return `${waiting} question${waiting === 1 ? "" : "s"} waiting for an answer`
      })()}
      className={`flex min-w-0 flex-col gap-3 ${className}`}
    >
      {questions.map((q) => {
        // Sent from here: greyed in its own slot at once, before the round-trip, the way the thread page
        // greys it from the settled list — never drawn open a second time while the board catches up.
        const sentAs = a.editing.has(q.id) ? undefined : a.sent.get(q.id)
        return sentAs ? <SettledQuestionCard key={q.id} s={sentAs} answering={a} /> : <RegisteredQuestionCard key={q.id} q={a.editing.get(q.id) ?? q} answering={a} />
      })}
      {a.error && <div role="alert" className="break-words text-[11px] leading-snug text-danger-soft">{a.error}</div>}
      {a.sending && (
        <div role="status" aria-live="polite" className="text-[11px] leading-snug text-muted">Sending…</div>
      )}
      {/* HUNG OFF THE QUESTIONS IT SENDS, not spaced like one more of them: 8px under the last card
          against the stack's 12px rhythm. On the queue card the reply box sits 17px below, and the
          stack's plain 12px there read as a button floating between the two, half an appendage of
          the box (the rule scripts/verify-open-ask-composer.mjs holds, from the maintainer's
          2026-07-22 "the spacing is insane": ≤10px up, at least 1.5x that down). Both marks here are
          filled or bordered boxes, so the box gap IS the ink gap.

          ONLY ONCE THE GROUP IS STARTED, and only while it would do something a question's own Send does
          not (groupFinish). Drawn disabled at all times, it read as the step still owed after every
          pick (2026-09-29). */}
      {finish && (
        <div className="-mt-1 flex justify-start">
          <button
            type="button"
            data-send-answers
            disabled={a.sending}
            title={finish.skip > 0 ? "Questions left blank go to the worker as skipped, and it can ask them again" : undefined}
            onClick={() => a.submitGroup(new Set(questions.map((q) => q.id)))}
            onMouseDown={(e) => e.preventDefault()}
            className={finish.send > 0 ? SEND_BUTTON : QUIET_BUTTON}
          >
            {finish.label}
          </button>
        </div>
      )}
    </section>
  )
}

/**
 * THE GROUP'S FOOTER BUTTON, and the words on it — or none. Each question sends on its own (a pick, its
 * own Send, Enter); this is the one control that speaks for the GROUP, and its label says exactly what a
 * click does, counts included (David 2026-10-08: "what each button will do and when things are
 * submitted"). It was "Send answers" until then, and since that morning it also skipped every blank
 * question — a skip its label never mentioned.
 *
 * Drawn once the human has started on the group — one of its questions answered, or something staged —
 * and only while it would do something a question's own Send does not: skip what is blank, or send two
 * or more at once. A lone half-filled question has its own Send and needs no second one beside it.
 */
function groupFinish(questions: readonly RegisteredQuestionView[], a: RegisteredAnswering, promptBoxSends = false): { label: string; send: number; skip: number } | undefined {
  // A reopened answer is none of the group's business (submitGroup leaves it out): left alone, it
  // keeps the answer it has, and its own Send or Cancel finishes it.
  const remaining = questions.filter((q) => !a.sent.has(q.id) && !a.dismissed.has(q.id))
  const send = remaining.filter((q) => a.unsent(q)).length
  const skip = remaining.length - remaining.filter((q) => a.unsent(q)).length
  // One `ask` stamps every question it registers with the same askedAt, so the settled list says whether
  // any of THIS group is answered — on the thread page too, where an answered one leaves this stack.
  const asked = new Set(questions.map((q) => q.askedAt))
  const started = send > 0 || questions.some((q) => a.sent.has(q.id)) || a.settled.some((s) => asked.has(s.askedAt))
  if (!started || (skip === 0 && send < 2)) return undefined
  // Under a prompt box whose Send carries every staged answer, the footer is only for what that Send
  // does not do: answering the blank questions as skipped.
  if (promptBoxSends && skip === 0) return undefined
  const label = send > 0 && skip > 0 ? `Send ${send}, skip ${skip}` : send > 0 ? `Send ${send} answers` : "Skip the rest"
  return { label, send, skip }
}

/** An answer's content, for telling a reopened answer's edit from the answer it opened on. Only what the
 *  human chose and typed — `questionId`/`question` restate the question, and `changed` is the server's. */
function answerKey(answer: QuestionAnswer): string {
  const walk = (a: QuestionAnswer): unknown => [a.chosen, a.text?.trim() ?? "", (a.followUps ?? []).map((f) => walk(f))]
  return JSON.stringify(walk(answer))
}

/** EVERY node path in a question's tree — live or not. The draft subscription and the clear-on-send both
 *  need the whole tree, not just what is currently on screen: text typed into a branch, abandoned, and
 *  returned to must still be there, and a settled question must leave nothing behind anywhere. */
function allPaths(q: RegisteredQuestionView): string[] {
  const out: string[] = []
  const walk = (node: RegisteredQuestionView["spec"], path: string) => {
    out.push(path)
    node.options?.forEach((option, optIdx) => {
      option.followUps?.forEach((child, fuIdx) => walk(child, `${path}/${optIdx}.${fuIdx}`))
    })
  }
  walk(q.spec, ROOT_PATH)
  return out
}

/** Is this question answered enough to send? Exported for the board card, which shows a count. */
export function questionIsStaged(q: RegisteredQuestionView, answers: ReadonlyMap<string, BlockAnswer>): boolean {
  return nodeAnswered(q.spec, answers.get(ROOT_PATH))
}

/** The staged picks and text that reproduce `answer` on its card, by node path — what Change opens a
 *  question on. The inverse of registeredAnswer: a chosen label back to its option, typed text back to
 *  its box, and each follow-up answer back under the option that opened it. */
function stagedFromAnswer(spec: RegisteredQuestionView["spec"], answer: QuestionAnswer): Map<string, BlockAnswer> {
  const out = new Map<string, BlockAnswer>()
  const walk = (node: RegisteredQuestionView["spec"], said: QuestionAnswer, path: string) => {
    const labels = (node.options ?? []).map((o) => o.label)
    const picked = said.chosen.map((label) => labels.indexOf(label)).filter((i) => i !== -1)
    const chosen = node.kind === "multi" ? null : (picked[0] ?? null)
    out.set(path, { chosen, chosenSet: node.kind === "multi" ? picked : [], text: said.text ?? "" })
    if (chosen === null) return
    const followUps = node.options?.[chosen]?.followUps ?? []
    followUps.forEach((child, i) => {
      const childSaid = said.followUps?.[i]
      if (childSaid) walk(child, childSaid, `${path}/${chosen}.${i}`)
    })
  }
  walk(spec, answer, ROOT_PATH)
  return out
}
