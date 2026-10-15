import { useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import { awaitingSteps, expandUserCommandDraft, heldQuestionViews, questionAnswerMessage, withAnswersNote, type AccountBackend, type ThreadView } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, store } from "../store.ts"
import { outgoingMessage } from "../lib/editorContext.ts"
import { restoreContextItems, takeContextItems, useStagedContextSources, useStagedContextTokens } from "../lib/stagedContext.ts"
import { useThreadComposerControls } from "../hooks/useThreadComposerControls.tsx"
import { Composer } from "./Composer.tsx"
import { EditorContextBar } from "./EditorContextBar.tsx"
import { EditorLine } from "./EditorLine.tsx"
import { embedFileMentions } from "../lib/editorReach.ts"
import { useMentionCandidates, useOwnMention } from "../hooks/useMentionCandidates.ts"
import { LogoutConfirmModal, SignInModal } from "./SignInModal.tsx"
import { draftKey, draftStore, mergeIntoDraft, useDraft, useProjectDir } from "../lib/drafts.ts"
import { noteFailedDraftOrigin, takeSupersededFailure } from "../lib/failedDelivery.ts"
import { parseAccountAlias } from "../lib/signIn.ts"
import { useEagerFollowUp, type EagerFollowUpCallbacks } from "../lib/eagerComposerSubmission.ts"
import { canInterruptAndSend } from "../lib/composerKeyboard.ts"
import { useDeliverQueuedNow } from "../lib/deliverQueuedNow.ts"
import { useQueryClient } from "@tanstack/react-query"
import type { TranscriptData } from "../hooks.ts"
import { RegisteredAnsweringContext } from "./RegisteredQuestionCards.tsx"
import { composerTerminalLine } from "../lib/threadTerminals.ts"
import { startComposerTerminal } from "./ThreadTerminals.tsx"
import { HeldThreadComposer } from "./HeldThreadBox.tsx"
import { useIsMobile } from "../lib/mobile.ts"
import { threadLifecycleAvailability } from "../lib/threadLifecycle.ts"
import { PhoneDoneButton } from "./PhoneDoneButton.tsx"
import { fetchThreadSkills, fetchUserCommands, mergeSlashItems, useUserCommands } from "../hooks/useUserCommands.ts"
import { RecurringPromptControl } from "./RecurringPromptControl.tsx"
import type { PhoneBarApi } from "./Composer.tsx"
import { SendScopeContext } from "../lib/sendScope.tsx"
import { sendPlaceholder, setSendMode, useSendMode } from "../lib/sendMode.ts"
import type { SurfaceFileDrop } from "../lib/fileDrop.ts"

// THE prompt box for a registered thread — the single block every "steer this thread" surface renders.
// The <Composer> leaf was already shared; the ~14 lines AROUND it were not, and the queue card's copy had
// silently drifted: it never intercepted the `/login` / `/logout` aliases, so typing `/login` into a cue
// card injected the literal string into the running worker's stdin while the same keystroke in the drawer
// opened the sign-in modal. Everything that must not diverge now lives here exactly once:
//
//   · the follow-up DRAFT key (so the queue card, the drawer and /full are the same textarea, and a
//     draft typed in one is present in the others — in any tab — and survives a reload),
//   · the `/login` | `/logout` alias intercept + its SignInModal / LogoutConfirmModal,
//   · useThreadComposerControls (the model/effort footer and the backend busy fence),
//   · the {controls.status} line under the box.
//
// The two call sites keep their DELIBERATE differences as props, never as a forked tree: the padding
// wrapper (`className`), whether the running-operations reading (`above` the box, the one line of
// counts) is drawn at all, and the send itself (`submitOverride`). Everything else is identical by construction, the Goal in the rail included.

export function ThreadComposerBox({
  slug,
  surface,
  className,
  id,
  above,
  submitOverride,
  phoneBarOverride,
  phoneChrome,
  fileDrop,
}: {
  slug: string
  // Pure data- tag forwarded to the textarea. Also the two surfaces' only behavioral fork inside
  // <Composer> itself (queueComposer owns Option-Enter); see lib/queueComposerKeyboard.ts.
  surface: "queueComposer" | "chatComposer"
  // The ONLY padding/chrome difference between the call sites — the drawer's bordered panel footer vs the
  // queue card's flush bottom block.
  className?: string
  // DOM id for the textarea. The drawer's is "followup-input".
  id?: string
  // Rendered INSIDE the padded box ABOVE the prompt: the line of live-op counts (QueueOpsSummary) the
  // queue card's docked box and the drawer's both carry, rather than rows hanging beneath it. Composed
  // by the caller — this component does not decide which ops a surface shows.
  above?: ReactNode
  // Replaces the default eager follow-up send. The queue card passes its useLiveAnswering `sendMessage`,
  // so the card's free-form reply and a reply that carries answers are literally the same send — one
  // controller, one optimistic card dissolve. Callers WITHOUT an answering controller (the drawer) omit
  // it and get the plain eager follow-up. Deliberately not split into a separate `onSent` prop: the
  // override already carries it, and a second copy here could only ever disagree.
  submitOverride?: (text: string, callbacks: EagerFollowUpCallbacks) => void
  // THE PHONE BAR'S THIRD STATE. While set, the drawer's resting phone bar renders this in place of
  // its row — a thread with open registered questions shows [keyboard] + "Answer N questions" there.
  // `api.editReply()` (the keyboard button) switches back to the prompt and focuses it inside the same
  // tap; the override returns once the field is empty and blurred. Ignored above the phone breakpoint
  // and on the queue card. See PhoneComposerLayout in Composer.tsx.
  phoneBarOverride?: (api: PhoneBarApi) => ReactNode
  // Whether the thread around this box wears the PHONE's chrome (MobileThreadHeader and its ⋯ sheet),
  // which is what the phone bar is built to sit under. ChatView knows: a drawer below the breakpoint
  // does, and /full never does — it keeps the desktop header at every width. Absent, the breakpoint
  // alone decides, as it did before the caller could say.
  phoneChrome?: boolean
  // The surface's file drop zone, when the SURFACE takes a dropped file rather than the box alone — the
  // queue card, anywhere on it. Desktop box only; see Composer's `fileDrop`.
  fileDrop?: SurfaceFileDrop
}): ReactElement {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((candidate) => candidate.id === slug)
  // THE ONE SEND (lib/sendScope). Everything staged on the surface's question cards leaves through
  // this box: the registered questions' answers (shared through their own context) and the fenced
  // ones (through the surface's scope). Either context may be absent — a box mounted with no question
  // surface around it simply has nothing staged.
  const registered = useContext(RegisteredAnsweringContext)
  const scope = useContext(SendScopeContext)
  const staged = (registered && registered.slug === slug ? registered.staged : 0) + (scope?.fencedCount ?? 0)
  // "A turn is in flight" — the only time sending as a steer and sending to the queue differ.
  const running = thread?.runtime === "running"
  const mode = useSendMode(slug, running)
  // ONE placeholder for both surfaces, decided here from the thread — the queue card said "Reply to the
  // agent…" and the drawer "Follow up…" until 2026-10-09, and only the card said when the box was the
  // way AROUND an open question. An open question is a registered one or a fence the worker's last
  // message still asks. With an answer staged the box is a note on it, and with the menu shut this line
  // is also what says how the button will send (sendPlaceholder).
  const placeholder = sendPlaceholder({ staged, openQuestions: Boolean(thread?.pendingQuestion) || heldQuestionViews(thread?.questions).length > 0, running, mode })
  const projectDir = useProjectDir()
  const key = draftKey.followUp(projectDir, slug, thread?.sessionId)
  const [message, setMessage, clearMessage] = useDraft(key)
  const controls = useThreadComposerControls(slug)
  const followUp = useEagerFollowUp(slug)
  const [signInFor, setSignInFor] = useState<AccountBackend | null>(null)
  const qc = useQueryClient()
  const userCommandsQuery = useUserCommands()
  const userCommands = userCommandsQuery.data?.commands
  // The thread's harness skills and the operator's own user commands, as one menu (useUserCommands.ts).
  const slashSuggest = useMemo(
    () => () => Promise.all([fetchThreadSkills(slug), fetchUserCommands(qc, projectDir)]).then(([skills, commands]) => mergeSlashItems(skills, commands)),
    [slug, qc, projectDir],
  )
  // `@` mentions offer every OTHER thread on the board — this one cannot usefully point at itself.
  const mentions = useMentionCandidates(slug)
  const ownMention = useOwnMention(slug)
  const [logoutFor, setLogoutFor] = useState<AccountBackend | null>(null)

  // The staged selections' tokens, painted as chips; deleting a token's text drops its item
  // (lib/stagedContext.ts). Keyed by this draft, so the queue card's copy of the box shows the same.
  const contextTokens = useStagedContextTokens(key, message)
  const contextSources = useStagedContextSources(key, projectDir)

  // INTERRUPT AND SEND is offered only when there is something to interrupt AND a runtime that can be
  // preempted — `runtime === "running"` is exactly "process alive, turn in flight". The backend policy
  // (Claude only; Codex steers, ACP queues) lives in canInterruptAndSend, pinned by its test.
  const canInterrupt = canInterruptAndSend(thread, submitOverride !== undefined)
  // ⌘/Ctrl-Enter in an EMPTY box pushes the queued follow-up through — the queued bubble's ↑, from the
  // keyboard. Same gate as the forced send, plus a queued message in the transcript cache, read at
  // keypress time so this box does not re-render on every transcript push.
  const { deliverNow } = useDeliverQueuedNow(slug)
  const pushQueued = () => {
    const messages = qc.getQueryData<TranscriptData>(["transcript", slug])?.messages
    if (!messages?.some((m) => m.queued)) return false
    deliverNow()
    return true
  }
  // THE PHONE BAR — the drawer's composer below the phone breakpoint (the queue card never renders
  // on a phone). Its right-hand verb follows the thread: Done while it rests and can be completed,
  // Send once there is text, a dimmed ↑ while a turn runs.
  const isMobile = useIsMobile()
  // NOT on /full at a narrow width: that page keeps the desktop header, so its box is the desktop box
  // too — the Goal rides this rail and nowhere else on desktop chrome, and the phone bar has no rail.
  const phoneBar = (phoneChrome ?? isMobile) && surface === "chatComposer"
  const turnRunning = thread?.runtime === "running" || thread?.runtime === "spawning"
  // NOT WHILE THE THREAD WAITS ON STEPS (`steps:` in its last fence). The card above carries its own
  // "Done", which means "I did the steps" and sends a reply; this one would mean "archive the thread",
  // and two Done verbs one above the other on a phone read as the same button.
  const stepsOpen = thread?.lastFence?.kind === "awaiting" && awaitingSteps(thread.lastFence.hints).length > 0
  const canComplete = thread ? threadLifecycleAvailability(thread).archive && !turnRunning && !stepsOpen : false
  // THE GOAL rides the rail on every desktop surface that steers an ntwine-owned session — the same
  // threads the lifecycle verbs in the header serve. The phone reaches it from the header's ⋯ sheet.
  const goal = thread && thread.kind === "session" && thread.foreign !== true ? <RecurringPromptControl thread={thread as ThreadView} /> : undefined

  function send(interrupt = false) {
    const text = message.trim()
    // The answers staged on the cards ride this send, on the desktop box only: the phone bar's answers
    // go through its own sheet (PhoneQuestionCards), which this bar never registered a send for.
    // Only this thread's: the provider above is the surface's, and a box never carries another thread's.
    const answers = !phoneBar && registered && registered.slug === slug ? registered.take() : null
    const fenced = phoneBar ? null : scope?.takeFenced() ?? null
    if (!text && !answers && !fenced) return
    // `/login` / `/logout` are ntwine-owned account actions for THIS thread's backend — invoked
    // locally, never delivered to the worker as a prompt (a leading slash is not a stable provider
    // command transport across the live-paste vs dead-resume lifecycles).
    const alias = parseAccountAlias(text)
    if (alias) {
      clearMessage()
      if (thread?.backend === "acp") {
        showToast("An ACP agent signs in through its own CLI — ntwine holds no account for it")
        return
      }
      const backend: AccountBackend = thread?.backend === "codex" ? "codex" : "claude"
      if (alias === "login") setSignInFor(backend)
      else setLogoutFor(backend)
      return
    }
    // `$ npm test` is not a message: it opens a terminal on this thread, in the folder its agent is working
    // in, running that line — a bare `$` opens a shell there (lib/threadTerminals.ts composerTerminalLine).
    // Only on a thread ntwine owns; the queue card's copy of this box stays a reply box.
    const terminal = surface === "chatComposer" && thread?.kind === "session" && !thread.foreign ? composerTerminalLine(text) : undefined
    if (terminal) {
      clearMessage()
      startComposerTerminal(rpc, slug, terminal.command, () => {
        if (!draftStore.get(key)) setMessage(message)
      })
      return
    }
    // Staged ⌘I context items ride the send: serialized into the text (before any trailing
    // attachment paths) and cleared with it — restored on a rejected send exactly like the draft. In an
    // editor's sidebar the drawer's box — the one that shows the context bar — also carries what the
    // editor has in front, read now; the queue card's copy shows no bar and so carries none of it. The
    // thread's transcript rides along so a selection it already quoted is named, not quoted again.
    // A USER COMMAND (`/commit fix the tests`) goes out as the prompt it names, expanded here so it means
    // the same on every backend; the transcript reads it back as what was typed (messagePresentation.ts).
    // A thread working in a worktree reads paths against IT, so they are written for it, with a word on
    // whose copy the context is (lib/composerContext.ts worktreeNote).
    const context = takeContextItems(key)
    const note = text
      ? outgoingMessage(expandUserCommandDraft(text, userCommands ?? []) ?? text, context, projectDir, surface === "chatComposer", {
          history: qc.getQueryData<TranscriptData>(["transcript", slug])?.messages,
          checkout: thread?.checkout,
        })
      : ""
    // ONE TURN (upstream 59089c92). Fenced answers are composed here and the typed words go under them as
    // the note; the registered ones are settled and composed by the server, above all of it
    // (FollowUpInput.answers), so `outgoing` may be empty when only those ride. `shown` is what the
    // optimistic bubble draws until the server's own copy replaces it.
    const outgoing = fenced ? withAnswersNote(fenced.wire, note) : note
    const shown = answers ? withAnswersNote(questionAnswerMessage(answers.display), outgoing) : outgoing
    const callbacks: EagerFollowUpCallbacks = {
      onOptimistic: () => {
        clearMessage()
        answers?.onOptimistic()
        fenced?.onOptimistic()
      },
      onSuccess: () => answers?.onSuccess(),
      ...(answers ? { answers: answers.answers, displayText: shown } : {}),
      // "Send to queue" is the ticked row AND there is a turn to queue behind. The forced send never
      // queues: ⌘/Ctrl-Enter means now.
      ...(mode === "queue" && running && !interrupt ? { hold: true } : {}),
      // Re-sending words an earlier failure handed back replaces that failure's bubble — see
      // lib/failedDelivery.ts.
      supersedes: takeSupersededFailure(key, outgoing),
      // Never clobber a newer draft typed while the request was in flight — and never DROP the failed
      // message for it either. This used to restore only into an empty box, so a failed send was
      // silently discarded whenever the operator had typed anything since; the words now go above
      // whatever is there (mergeIntoDraft). The server keeps its own copy too when it can (`kept`),
      // because this draft lives in ONE browser's localStorage: clearing site data loses it, and no
      // other browser or device ever sees it.
      onRollback: (failure) => {
        mergeIntoDraft(key, message)
        restoreContextItems(key, context)
        noteFailedDraftOrigin(key, { ...failure, text: message })
        answers?.onRollback(failure.kept)
        fenced?.onRollback()
      },
    }
    // PICKED ANSWERS RIDE THE REPLY. A reply typed with a card's chip lit is the human adding a note to
    // that answer, not skipping it — sending the reply alone replied past the question and dropped the
    // pick (2026-09-29). Until upstream 59089c92 the answers went first and the reply after they landed;
    // now both are this one send, which the server delivers as one turn.
    if (submitOverride) submitOverride(outgoing, callbacks)
    else followUp.submit(outgoing, { ...callbacks, interrupt })
  }

  // Register this box as its surface's send, so Enter in a question card's own text box — and the
  // queue card's card-level Enter — is this same send, typed words included. Through a ref: `send`
  // closes over the current draft and staged answers, and is a new function every render. Above the
  // held thread's early return below, so the hooks run in one order on every render.
  const sendRef = useRef(send)
  sendRef.current = send
  const composerHandle = phoneBar || thread?.held !== undefined ? undefined : scope?.composer
  useEffect(() => {
    if (!composerHandle) return
    const run = () => sendRef.current()
    composerHandle.set(run)
    return () => composerHandle.set(null)
  }, [composerHandle])

  // A HELD THREAD has no agent to steer yet: its box is what it will start with, and sending it starts one
  // (HeldThreadBox.tsx).
  if (thread?.held !== undefined) {
    return (
      <div {...(surface === "chatComposer" ? { "data-thread-action-bar": "" } : {})} className={className}>
        <HeldThreadComposer thread={thread as ThreadView} surface={surface} id={id} />
      </div>
    )
  }

  if (phoneBar) {
    return (
      <div data-thread-composer-box={surface} data-thread-action-bar="" data-phone-thread-bar="">
        <Composer
          contextTokens={contextTokens}
          id={id}
          surface={surface}
          value={message}
          onChange={setMessage}
          onSubmit={() => send()}
          onInterruptSubmit={canInterrupt ? () => send(true) : undefined}
          slashSuggest={slashSuggest}
          // A command saved in Settings refreshes the menu on the next `/`.
          slashSuggestVersion={userCommandsQuery.dataUpdatedAt}
          // The verb is the thread's state: steering a turn in flight, or replying to one at rest.
          placeholder={turnRunning ? "Steer…" : "Reply…"}
          busy={controls.busy}
          phone={{
            layout: "bar",
            tools: controls.phoneTools,
            idlePrimary: canComplete && thread ? (compact) => <PhoneDoneButton thread={thread as ThreadView} compact={compact} /> : undefined,
            override: phoneBarOverride,
            onLongPressSend: canInterrupt ? () => send(true) : undefined,
          }}
        />
        {controls.status}
        {signInFor && <SignInModal backend={signInFor} onClose={() => setSignInFor(null)} onAuthed={() => setSignInFor(null)} />}
        {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
      </div>
    )
  }

  return (
    // `data-thread-action-bar` stays the drawer footer's stable anchor (fixtures/QA scripts measure the
    // prompt-box inset from it); `data-thread-composer-box` addresses either surface's block.
    <div
      data-thread-composer-box={surface}
      {...(surface === "chatComposer" ? { "data-thread-action-bar": "" } : {})}
      className={className}
    >
      {above}
      <Composer
        contextTokens={contextTokens}
        contextSources={contextSources}
        // In an editor's sidebar, what the editor has in front, one click from a chip in this box. The
        // drawer's box only: the queue card's copy of it is one of many on a page, and a bar on each
        // would be noise.
        header={surface === "chatComposer" ? <EditorContextBar box={{ key, projectDir, surface }} /> : undefined}
        // In a browser tab, the same box's quiet line naming what the editor beside it has in front.
        aside={surface === "chatComposer" ? <EditorLine box={{ key, projectDir, surface }} /> : undefined}
        id={id}
        surface={surface}
        value={message}
        onChange={setMessage}
        onSubmit={() => send()}
        onInterruptSubmit={canInterrupt ? () => send(true) : undefined}
        onPushQueued={canInterrupt ? pushQueued : undefined}
        onEffortStep={controls.stepEffort}
        slashSuggest={slashSuggest}
          // A command saved in Settings refreshes the menu on the next `/`.
          slashSuggestVersion={userCommandsQuery.dataUpdatedAt}
        mentionCandidates={mentions}
        ownMention={ownMention}
        // In an editor's sidebar, `@` offers the editor's files too, and a file dragged in from its
        // explorer lands as a reference (lib/editorReach.ts).
        fileMentions={embedFileMentions(projectDir)}
        placeholder={placeholder}
        // NOT `|| followUp.pending`. The send is already committed locally (draft cleared, bubble
        // appended, and in the queue the card has already begun dissolving), so gating the textarea on
        // its round-trip only made the box go dead — and, because the browser blurs a disabled element,
        // cost the caret — for the ~½s the injection takes. What remains is a genuine backend
        // fence: a permission/profile change owning the runtime.
        busy={controls.busy}
        footer={controls.footer}
        railLead={goal}
        railPermission={controls.permission}
        fileDrop={fileDrop}
        send={{ mode, onMode: (next) => setSendMode(slug, next), running, staged }}
      />
      {controls.status}
      {signInFor && <SignInModal backend={signInFor} onClose={() => setSignInFor(null)} onAuthed={() => setSignInFor(null)} />}
      {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
    </div>
  )
}
