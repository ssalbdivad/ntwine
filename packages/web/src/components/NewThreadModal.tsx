import * as RadixDialog from "@radix-ui/react-dialog"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useIsMutating, useMutation, useQuery } from "@tanstack/react-query"
import { expandUserCommandDraft, type AccountBackend, type CreateScheduleInput, type DispatchInput } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { useSnapshot } from "valtio"
import { showToast, store } from "../store.ts"
import { Composer, composerExcludeRuns } from "./Composer.tsx"
import { EditorContextBar } from "./EditorContextBar.tsx"
import { EditorLine } from "./EditorLine.tsx"
import { embedFileMentions } from "../lib/editorReach.ts"
import { useMentionCandidates } from "../hooks/useMentionCandidates.ts"
import { userCommandItems, useUserCommands } from "../hooks/useUserCommands.ts"
import { ProfileGridSelector } from "./ProfileGridSelector.tsx"
import { SETTINGS_WRITE_KEY } from "../hooks/useSettingsAutosave.tsx"
import { AcpModelSelect } from "./AcpModelSelect.tsx"
import { MakeDefaultButton } from "./MakeDefaultButton.tsx"
import { LogoutConfirmModal, SignInModal } from "./SignInModal.tsx"
import { dispatchProfileGroups } from "../lib/dispatchPreferences.ts"
import { stepProfileGridEffort } from "../lib/profileGrid.ts"
import { useDispatchProfile, useDraftDispatchPick } from "../hooks/useDispatchProfile.ts"
import { focusedEscapeClaim, handleDialogEscape, registerEscapeClaim } from "../lib/selectOverlay.ts"
import { draftKey, draftStore, mergeIntoDraft, useDraft, useProjectDir } from "../lib/drafts.ts"
import { clearDispatchDraft } from "../lib/scheduleDraftState.ts"
import type { ComposerContextItem } from "../lib/composerContext.ts"
import { outgoingMessage } from "../lib/editorContext.ts"
import { restoreContextItems, stagedItems, takeContextItems, useStagedContextSources, useStagedContextTokens } from "../lib/stagedContext.ts"
import { projectSlug } from "../lib/base-path.ts"
import { parseAccountAlias } from "../lib/signIn.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"
import { aboveDrawersZ } from "../lib/overlaySurface.ts"
import { phoneLayout } from "../lib/mobile.ts"
import { useLiveSchedule, type DetachedDraft } from "./ScheduleComposer.tsx"
import { joinComposerValue, splitComposerValue } from "../lib/imagePaths.ts"
import { resolveDraftDeadline } from "../lib/threadDeadline.ts"
import { DispatchTimeLimit } from "./DeadlineControl.tsx"
import { composerTerminalLine } from "../lib/threadTerminals.ts"
import { TerminalFolderPicker } from "./TerminalFolderPicker.tsx"

/** The directories of the project a prompt box dispatches into, named by its caller (DispatchForm `dirs`). */
export interface DispatchDirs {
  projectDir: string | undefined
  homeDir: string | undefined
}

// THE prompt box: it starts an agent thread. Shared by every surface that can start one: the rail, the
// empty board's centered box and the anywhere-modal.
//
// A `$ cmd` LINE STARTS A TERMINAL THREAD instead (plans/terminal-threads.md, 2026-10-15): `$ nub run dev`
// runs that command, a bare `$` opens a shell, in the folder the box's picker names — the project root or one
// of its `.ntwine/worktrees/*` checkouts, which takes the model picker's place while the line is a command.
// (A Terminal tab did this from 2026-09-23 to 2026-09-29, when a terminal moved onto a thread; it is a thread
// of its own again, with no tab: the `$` is the switch.)
export function DispatchForm({
  autoFocus,
  onDispatched,
  target,
  dirs,
  onLeadingProject,
}: {
  autoFocus?: boolean
  onDispatched?: () => void
  /**
   * WHERE the thread goes, when that is a choice — the cross-project page's project picker. It is the
   * FIRST pill in the box's bottom strip, beside the model, because it is a setting of the thread about
   * to start, like the model. It sat at the tab row's right end until 2026-09-28, directly under the
   * status row's project filter, and two project names stacked one over the other read as one control
   * (maintainer: "lack of clarity on the distinction between the filter view … and the prompt selection
   * box"). A board has no choice to make and passes nothing.
   */
  target?: ReactNode
  /**
   * The directories of the project the box dispatches into, when the caller knows them before the
   * store's board for it has landed — the cross-project page re-aiming its box (AllQueues.tsx
   * FocusedComposer). They key the drafts, so the box can take the new project at once rather than
   * waiting on its feed. Everywhere else the store's board is the page project's, and says the same.
   */
  dirs?: DispatchDirs
  /** A prompt opening with `#slug ` goes to that project (Composer `onLeadingProject`) — where the box has a
   *  project to choose, which is the queue page's. Returns the directory the words went to, or false when
   *  they could not go and the token stays text. */
  onLeadingProject?: (slug: string, value: string) => string | false
}) {
  return (
    <div data-dispatch-form className="w-full flex flex-col gap-1.5">
      <PromptForm autoFocus={autoFocus} onDispatched={onDispatched} target={target} dirs={dirs} onLeadingProject={onLeadingProject} />
    </div>
  )
}

// The prompt form — composer + quiet selects row. There is no title field — the server derives a
// fallback and Claude names the session itself (ai-title), which the UI prefers for display.
function PromptForm({
  autoFocus,
  onDispatched,
  target,
  dirs,
  onLeadingProject,
}: {
  autoFocus?: boolean
  onDispatched?: () => void
  target?: ReactNode
  dirs?: DispatchDirs
  onLeadingProject?: (slug: string, value: string) => string | false
}) {
  // A settings write still in flight — a compaction window picked in the model picker a moment ago —
  // must land before a dispatch that would read it.
  const savingSettings = useIsMutating({ mutationKey: [...SETTINGS_WRITE_KEY] }) > 0
  // A new thread can be pointed at any thread on the board it is dispatched into (`@shell-budgets`).
  const mentions = useMentionCandidates()
  // No session yet, so no harness to list skills: the `/` menu here is the operator's own user commands,
  // which ntwine expands itself (useUserCommands.ts) — `/commit` starts a thread on that prompt.
  const userCommandsQuery = useUserCommands()
  const userCommands = userCommandsQuery.data?.commands
  const slashSuggest = useMemo(() => () => Promise.resolve(userCommandItems(userCommands ?? [])), [userCommands])
  const expandedPrompt = (text: string) => expandUserCommandDraft(text, userCommands ?? []) ?? text
  const boardDir = useProjectDir()
  const projectDir = dirs ? dirs.projectDir : boardDir
  // Queue and modal are the same semantic new-thread composer.
  const [prompt, setPrompt] = useDraft(draftKey.dispatch(projectDir))
  const promptKey = draftKey.dispatch(projectDir)
  // AFTER A LEADING `#slug` SENT THE WORDS ELSEWHERE, this box is on its way out — but on a project's board
  // the re-aim is a navigation, and a key typed before it lands still reaches this box. It goes after the
  // words it followed rather than into a stray draft here. This box was emptied by the move, so each edit
  // it sees is only what was typed since.
  const handedTo = useRef<string | null>(null)
  const onPromptChange = (value: string) => {
    if (handedTo.current === null) return setPrompt(value)
    const key = draftKey.dispatch(handedTo.current)
    draftStore.set(key, draftStore.get(key) + value)
  }
  const leadingProject = onLeadingProject && ((slug: string, value: string) => {
    const dir = onLeadingProject(slug, value)
    if (dir === false) return false
    if (dir !== projectDir) handedTo.current = dir
    return true
  })
  const submittedDraftRef = useRef("")
  // SELECTED CONTEXT in a new thread's prompt — a selection sent from an editor window lands here as an
  // `@a.ts:12-20` chip (lib/editorCompose.ts), staged under this box's own draft key and serialized into
  // the prompt on dispatch exactly as a reply box serializes it (composerContext.ts), so the new thread's
  // first message renders its chips like any later one. The box had no chips until 2026-10-01.
  const contextTokens = useStagedContextTokens(promptKey, prompt)
  const contextSources = useStagedContextSources(promptKey, projectDir)
  const submittedContextRef = useRef<ComposerContextItem[]>([])
  const [pendingDispatch, setPendingDispatch] = useState<string | null>(null)
  // The new-thread default with this prompt's own pick over it. The pick is part of the draft: it
  // lasts until this prompt is dispatched, then the box is back on the default — escalating one task to max no longer leaves every later thread on max.
  const pickKey = draftKey.dispatchProfile(projectDir)
  const pickState = useDraftDispatchPick(pickKey)
  const [pick, setPick] = pickState
  const submittedPickRef = useRef(pick)
  // What was said about the draft's schedule ("not a schedule", an Undo) is part of the draft too
  // (lib/scheduleDraftState.ts): a submit that fails puts it back with the words.
  const scheduleKey = draftKey.dispatchSchedule(projectDir)
  const submittedScheduleRef = useRef("")
  // THE TIME LIMIT typed for this prompt (DeadlineControl DispatchTimeLimit): raw text in the draft, beside
  // the pick, resolved to an instant only at the Enter that starts the thread (startNow). It leaves the box
  // with the dispatch and comes back with a failed one, on the pick's terms.
  const limitKey = draftKey.dispatchDeadline(projectDir)
  const submittedLimitRef = useRef("")
  const restoreLimit = () => {
    if (submittedLimitRef.current && !draftStore.get(limitKey)) draftStore.set(limitKey, submittedLimitRef.current)
  }
  /** A failed submit's words back into a still-empty box — and, in the same commit, what was said about their
   *  schedule. Without it the strip and ↻ came back over words the human had said were not a schedule (or had
   *  just undone), and the retry Enter created it (fix round 2026-10-06, H). */
  const restoreSubmitted = (prompt: string) => {
    if (draftStore.get(promptKey)) return
    const schedule = submittedScheduleRef.current
    draftStore.setMany({ [promptKey]: prompt, ...(schedule && !draftStore.get(scheduleKey) ? { [scheduleKey]: schedule } : {}) })
  }
  // A file on its way into the box: a held Enter waits for no answer while it uploads (ScheduleComposer.tsx).
  const [uploading, setUploading] = useState(false)
  const { resolved, defaultResolved, picked, codexList, claudeList, acpList, loadError: profileLoadError, choose, chooseAcpModel, makeDefault } = useDispatchProfile(pickState)
  // THE `$` LINE: what it runs (undefined ⇒ the words are a prompt), and the folder the picker names.
  const terminalLine = useMemo(() => composerTerminalLine(prompt), [prompt])
  const [terminalDir, setTerminalDir] = useState<string | undefined>(undefined)
  const terminalKey = projectDir ?? ""
  const terminalDirFor = useRef(terminalKey)
  if (terminalDirFor.current !== terminalKey) {
    // Another project's box: its folders are its own.
    terminalDirFor.current = terminalKey
    if (terminalDir !== undefined) setTerminalDir(undefined)
  }
  const startTerminal = useMutation({
    mutationFn: (input: { command?: string; cwd?: string }) => {
      const project = projectSlug()
      return rpc.terminalThreadStart(input).then((res) => ({ ...res, project }))
    },
    onSuccess: (res) => {
      onDispatched?.()
      showToast("Terminal started", { link: { label: "Open terminal", slug: res.id, project: res.project } })
    },
    onError: (e, input) => {
      restoreSubmitted(input.command === undefined ? "$" : `$ ${input.command}`)
      showToast(`Could not start the terminal: ${(e as Error).message.slice(0, 80)}`)
    },
  })

  // Per-provider LOCAL credential presence, polled so the submit gate has a fresh value without a
  // round-trip on every keystroke. The gate blocks ONLY on a positive "signed-out" (fails open on
  // "unknown"/loading/error), so a stale or missing snapshot can never trap a logged-in user.
  const authStatus = useQuery({ queryKey: ["authStatus"], queryFn: () => rpc.authStatus(), staleTime: 30_000 })
  // When submit is gated, the built dispatch is stashed here and the sign-in modal opens for this
  // backend; a successful re-check runs the stashed dispatch unchanged.
  const [signInFor, setSignInFor] = useState<AccountBackend | null>(null)
  const [logoutFor, setLogoutFor] = useState<AccountBackend | null>(null)
  const gatedInputRef = useRef<DispatchInput | null>(null)

  // Dispatch does NOT navigate anywhere: you stay on the queue, the new thread appears in the
  // sidebar, and the toast walks through the lifecycle — an immediate spinner while the server
  // waits out session startup, then a link that opens the thread in the side drawer.
  // `note`: why words with a schedule word in them started as a thread (ScheduleComposer `defer`) — said on the
  // toast, never sent.
  const dispatch = useMutation({
    mutationFn: ({ note: _note, ...input }: DispatchInput & { note?: string }) => {
      const project = projectSlug()
      return rpc.dispatch(input).then((res) => ({ ...res, project }))
    },
    onMutate: ({ note }) => showToast("Starting thread…", { spinner: true, sticky: true, ...(note ? { detail: note } : {}) }),
    onSuccess: (res, { note }) => {
      // The board stream now owns the durable thread row. Drop our local bridge as soon as the
      // server acknowledges it, preventing an optimistic card + server card duplicate.
      setPendingDispatch(null)
      onDispatched?.()
      showToast("Thread started", { link: { label: "Open thread", slug: res.slug, project: res.project }, ...(note ? { detail: note } : {}) })
    },
    onError: (e, input) => {
      // A submit clears before the RPC starts. Restore only into a still-empty field so retry is
      // effortless without overwriting text typed during the failed request.
      restoreSubmitted(submittedDraftRef.current || input.prompt)
      // Its chips come back with it, or the restored token would be bare text with nothing behind it.
      restoreContextItems(promptKey, submittedContextRef.current)
      submittedContextRef.current = []
      // The pick comes back with its prompt, on the same terms: a retry must not quietly run on the
      // default, and a pick made during the failed request is not overwritten.
      if (!draftStore.get(pickKey)) setPick(submittedPickRef.current)
      restoreLimit()
      setPendingDispatch(null)
      // Server-side auth preflight rejection (the client gate can miss on a stale snapshot): open the
      // same sign-in modal with the dispatch stashed, instead of a dead-end failure toast. The server
      // created no thread state, and the draft was restored above.
      const auth = /^AUTH_REQUIRED:(claude|codex)$/.exec((e as Error).message)
      if (auth) {
        gatedInputRef.current = input
        setSignInFor(auth[1] as AccountBackend)
        showToast(`Signed out of ${auth[1] === "claude" ? "Claude" : "Codex"}`, { duration: 3000 })
        return
      }
      showToast(`Dispatch failed: ${(e as Error).message.slice(0, 80)}`)
    },
  })

  // Fire the dispatch and do the one-shot UI bookkeeping (optimistic toast + prompt clear). Called both
  // on a clean submit and after the sign-in gate is cleared, so the prompt is only cleared once the
  // thread is actually being started — a gated submit leaves the draft intact.
  function runDispatch(input: DispatchInput) {
    submittedDraftRef.current = prompt
    submittedPickRef.current = pick
    submittedScheduleRef.current = draftStore.get(scheduleKey)
    submittedLimitRef.current = draftStore.get(limitKey)
    // Taken here, not in submit: a submit the sign-in gate holds keeps its draft, and so its chips.
    submittedContextRef.current = takeContextItems(promptKey)
    // The prompt, its pick and what was said about its schedule in ONE commit (lib/scheduleDraftState.ts):
    // no subscriber ever renders this text with another draft's dismissal, or the reverse.
    clearDispatchDraft(projectDir)
    setPendingDispatch(input.prompt)
    dispatch.mutate(input)
  }

  // THE SCHEDULE IN THE WORDS (ARCHITECTURE.md § Scheduled threads, ScheduleComposer.tsx): there is no schedule button
  // and no mode. A prompt with a schedule word in it is read by the model as it is typed; when the words ask for
  // the work to repeat, a strip under the box says what will run when, the send wears ↻, and Enter creates the
  // schedule instead of starting the thread. It reads the PROSE the box shows (what every span indexes), never
  // the code, chips, mentions or commands in it; what it would save is the prompt with its chips
  // but never the editor block, because a schedule's prompt is sent hours or weeks later.
  const rootRef = useRef<HTMLDivElement>(null)
  const { prose: promptProse, attachments: promptAttachments } = useMemo(() => splitComposerValue(prompt), [prompt])
  const scheduleExclude = useMemo(() => composerExcludeRuns(promptProse, contextTokens), [promptProse, contextTokens])
  const schedule = useLiveSchedule({
    // What the human said about the draft's schedule ("not a schedule") is part of the draft, under its sibling
    // key: it survives a remount and a reload, and the page box and the `c` dialog over it — one draft — agree.
    draftKey: draftKey.dispatchSchedule(projectDir),
    // A `$` line is a command, never a schedule's words.
    prose: terminalLine ? "" : promptProse,
    exclude: scheduleExclude,
    promptOf: (cut) => {
      const value = joinComposerValue(cut, promptAttachments.map((a) => a.path))
      return value.trim() ? outgoingMessage(expandedPrompt(value), stagedItems(promptKey), projectDir, false).trim() : ""
    },
    profile: resolved
      ? { model: resolved.model, backend: resolved.backend, effort: (resolved.effort || undefined) as CreateScheduleInput["effort"] }
      : undefined,
    uploading,
    startNow,
    detach,
    onCreated: (submittedProse) => {
      // The draft became the schedule: the prompt, its chips and its pick leave the box in one commit. Words
      // typed after Enter (during the mark's wash) stay; Undo puts the rest back exactly.
      const { prose: now, attachments } = splitComposerValue(draftStore.get(promptKey))
      const after = now === submittedProse ? "" : now.startsWith(submittedProse) ? now.slice(submittedProse.length).trimStart() : now
      const taken = joinComposerValue(submittedProse, attachments.map((a) => a.path))
      const items = takeContextItems(promptKey)
      const pickRaw = draftStore.get(pickKey)
      const limitRaw = draftStore.get(limitKey)
      clearDispatchDraft(projectDir)
      if (after.trim()) draftStore.set(promptKey, after)
      onDispatched?.()
      return () => {
        mergeIntoDraft(promptKey, taken)
        restoreContextItems(promptKey, items)
        if (pickRaw && !draftStore.get(pickKey)) draftStore.set(pickKey, pickRaw)
        if (limitRaw && !draftStore.get(limitKey)) draftStore.set(limitKey, limitRaw)
      }
    },
    focus: () => {
      // This box, or — once the `c` dialog that created it has closed — the page's box on the same draft.
      requestAnimationFrame(() => {
        const el = rootRef.current?.querySelector<HTMLTextAreaElement>("textarea")
          ?? document.querySelector<HTMLTextAreaElement>('textarea[data-surface="newComposer"]')
        if (!el) {
          // A PHONE has no box on its page: it lives in the New thread sheet, which closed when the schedule was
          // made. Undo opens it again, on the words it put back and their line — it changed nothing on screen
          // until the human happened to tap New thread (fix round 2026-10-06, F3).
          if (phoneLayout()) store.phoneNewThread = { focus: true }
          return
        }
        el.focus({ preventScroll: true })
        el.setSelectionRange(el.value.length, el.value.length)
      })
    },
  })

  // ESCAPE IN THE `c` DIALOG IS THE SCHEDULE'S FIRST. Radix closes a dialog on Escape at the document's capture
  // phase, before the box below ever sees the key, so the box's own `onEscape` never ran there: one Escape
  // threw the dialog away with a schedule on screen. This claim is asked first (lib/selectOverlay.ts) and takes
  // the key only while the schedule has something to do with it (a strip to dismiss, a held Enter to cancel)
  // AND focus is inside THIS box — the page box under the dialog shares the draft, but not the key. The next
  // Escape closes the dialog as before. On the page itself there is no dialog and `onEscape` is the whole story.
  const escapeScheduleRef = useRef(schedule.onEscape)
  escapeScheduleRef.current = schedule.onEscape
  // An open slash or mention menu in this box, or an IME composing, owns the key before the schedule does: the
  // claim PASSES it on, so the dialog stays and the box's own handler closes the menu.
  useEffect(() => registerEscapeClaim(focusedEscapeClaim(() => rootRef.current, (event) => {
    if (event?.isComposing || rootRef.current?.querySelector("[data-slash-menu], [data-mention-menu]")) return "pass"
    return escapeScheduleRef.current()
  })), [])

  // ENTER — and the send button, and ⌘↵, which is Enter here — is the one submit. The account aliases are
  // settled first, as before; then the words decide (ScheduleComposer.tsx, lib/scheduleIntent.ts `submitAct`):
  // a schedule in them is created, anything else starts the thread through `startNow`, and words with a
  // schedule word the model has not answered for yet leave the box at once and are settled when it does.
  function submit() {
    // A `$` line runs, whatever the model picker says: it needs no model, no sign-in and no schedule.
    if (terminalLine) {
      if (startTerminal.isPending) return
      submittedScheduleRef.current = ""
      clearDispatchDraft(projectDir, { keepPick: true })
      startTerminal.mutate({ ...(terminalLine.command ? { command: terminalLine.command } : {}), ...(terminalDir ? { cwd: terminalDir } : {}) })
      return
    }
    if (!prompt.trim() || !resolved || savingSettings) return
    // `/login` and `/logout` are ntwine-owned aliases for the typed provider account actions — they
    // invoke the sign-in / sign-out flow for the SELECTED backend and never become prompt text.
    const alias = parseAccountAlias(prompt)
    if (alias) {
      // The text was an account action, not this thread: the pick it is about to sign in to stays.
      clearDispatchDraft(projectDir, { keepPick: true })
      if (resolved.backend === "acp") {
        showToast("An ACP agent signs in through its own CLI — ntwine holds no account for it")
        return
      }
      if (alias === "login") {
        gatedInputRef.current = null // nothing to dispatch after sign-in — this is a pure account action
        setSignInFor(resolved.backend)
      } else {
        setLogoutFor(resolved.backend)
      }
      return
    }
    schedule.submit()
  }

  /** Start the thread now: what Enter has always done, and still does for words that are not a schedule. */
  function startNow() {
    const input = dispatchInput()
    if (input) gateAndDispatch(input)
  }

  /** The dispatch these words would make, or undefined — having said why — when they cannot start now. */
  function dispatchInput(): DispatchInput | undefined {
    if (!prompt.trim() || !resolved || savingSettings || parseAccountAlias(prompt)) return
    if (!resolved.modelAvailable) {
      showToast("Saved model is unavailable — choose a model before starting the thread")
      return
    }
    if (!resolved.effortAvailable) {
      showToast("Saved reasoning level is unavailable for this model — choose another level")
      return
    }
    // The limit resolves HERE, at the Enter that starts the thread: "2h" is two hours of the thread's
    // own, not two hours from when it was typed. Text that no longer parses — a clock time now under a
    // minute away — stops the submit and says why, with the draft and the limit left as they were.
    const limit = resolveDraftDeadline(draftStore.get(limitKey), Date.now())
    if (!limit.ok) {
      showToast(`Time limit: ${limit.error}`)
      return
    }
    const expanded = expandedPrompt(prompt)
    return {
      // The chips, and in an editor's sidebar what the editor has in front at THIS Enter
      // (lib/editorContext.ts outgoingMessage). Built here, once: a dispatch the sign-in gate holds runs
      // with this input after the sign-in, so it carries what the human saw when they pressed Enter.
      prompt: outgoingMessage(expanded, stagedItems(promptKey), projectDir, true).trim(),
      // A user command's thread is titled by what was typed, not by the first words of its wrapper.
      ...(expanded !== prompt ? { title: prompt.trim().split("\n")[0]!.slice(0, 120) } : {}),
      // No permissionMode: the server stamps every created worker itself (workerDispatchPermission —
      // the non-interactive floor, raised to bypass only when Settings asks). Dispatch offers no
      // per-thread permission choice; the "Permissions" control behind the Claude Code gear in the model
      // picker (AgentSettingsPopover) owns the default.
      model: resolved.model,
      backend: resolved.backend,
      // An ACP profile resolves to effort "" (no effort axis); the RPC's enum takes that as ABSENT.
      // Sending "" failed every ACP dispatch from the composer with "Invalid enum value" (2026-09-16).
      effort: (resolved.effort || undefined) as DispatchInput["effort"],
      ...(limit.deadline ? { deadline: limit.deadline } : {}),
    }
  }

  function gateAndDispatch(input: DispatchInput) {
    // Auth gate: block ONLY on a positive "signed-out" for this dispatch's backend. Loading/unknown/
    // authed all fall through (fail open) so a flaky or slow read never blocks a logged-in user. An ACP
    // agent has no account here at all — its own CLI reports a missing login on the first prompt.
    const backend = input.backend ?? "claude"
    if (backend !== "acp" && authStatus.data?.[backend] === "signed-out") {
      gatedInputRef.current = input
      setSignInFor(backend)
      return
    }
    runDispatch(input)
  }

  /**
   * Submit words the schedule check has not answered for yet (ScheduleComposer `defer`): the whole draft leaves
   * the box NOW — the prompt, its chips, its pick, its limit, what was said about its schedule — and what it
   * becomes is decided when the reading lands. Its dispatch input is built HERE, at the Enter, so the thread
   * carries what the human saw when they pressed it; a schedule's prompt is built from the same captured chips.
   */
  function detach(): DetachedDraft | undefined {
    const input = dispatchInput()
    if (!input) return
    const value = prompt
    const { attachments } = splitComposerValue(value)
    const pickRaw = draftStore.get(pickKey)
    const limitRaw = draftStore.get(limitKey)
    const scheduleRaw = draftStore.get(scheduleKey)
    const pickNow = pick
    const items = takeContextItems(promptKey)
    clearDispatchDraft(projectDir)
    onDispatched?.()
    const restore = () => {
      mergeIntoDraft(promptKey, value)
      restoreContextItems(promptKey, items)
      if (pickRaw && !draftStore.get(pickKey)) draftStore.set(pickKey, pickRaw)
      if (limitRaw && !draftStore.get(limitKey)) draftStore.set(limitKey, limitRaw)
    }
    return {
      dispatch: (note) => {
        const backend = input.backend ?? "claude"
        if (backend !== "acp" && authStatus.data?.[backend] === "signed-out") {
          // Signed out since the Enter: the words go back, and the sign-in runs them as before.
          restore()
          if (scheduleRaw && !draftStore.get(scheduleKey)) draftStore.set(scheduleKey, scheduleRaw)
          gatedInputRef.current = input
          setSignInFor(backend)
          return
        }
        // What a failed dispatch puts back (`restoreSubmitted`), as it was at the Enter.
        submittedDraftRef.current = value
        submittedPickRef.current = pickNow
        submittedScheduleRef.current = scheduleRaw
        submittedLimitRef.current = limitRaw
        submittedContextRef.current = items
        setPendingDispatch(input.prompt)
        dispatch.mutate({ ...input, ...(note ? { note } : {}) })
      },
      promptOf: (cut) => {
        const joined = joinComposerValue(cut, attachments.map((a) => a.path))
        return joined.trim() ? outgoingMessage(expandedPrompt(joined), items, projectDir, false).trim() : ""
      },
      restore,
    }
  }

  // The profile readout lives INSIDE the box, along its bottom edge — petite caps, very quiet.
  // Not a dropdown at rest: a plain value; hover materializes the border, click opens the menu.
  // There is no permission control: dispatch permission is fixed server-side.
  //
  // useMemo (measured in the render-perf profile): the footer used to be rebuilt inline on every
  // render, so each prompt KEYSTROKE re-rendered every picker tree — ~222 component renders per
  // keystroke. A keystroke only changes `prompt`; keeping the footer element's identity stable lets
  // React bail out of the whole control subtree, and the
  // element is rebuilt exactly when the default, this box's pick or the model catalogue changes.
  const terminalMode = terminalLine !== undefined
  const footer = useMemo(() => {
    // A `$` line needs no model: the strip names where it will run instead.
    if (terminalMode) {
      return (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {target}
          <TerminalFolderPicker value={terminalDir} onValueChange={setTerminalDir} />
        </div>
      )
    }
    if (!resolved) {
      return (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {target}
          <ProfileGridSelector
            groups={[]}
            value={undefined}
            onValueChange={() => {}}
            placeholder={profileLoadError ? "Profile unavailable" : "Profile loading…"}
            ariaLabel="Model and effort loading"
            disabled
          />
        </div>
      )
    }
    const profileGroups = dispatchProfileGroups(codexList, acpList, claudeList)
    const acpAgent = resolved.acpAgentId ? acpList.find((agent) => agent.id === resolved.acpAgentId) : undefined
    return (
      // gap-x-1.5 between the two pills, the same measured gap the thread composer's strip uses
      // (useThreadComposerControls): two bordered pills on `gap-x-1` read as one segmented control.
      // The same 6px between ROWS: on a phone the pill and "Make default" wrap, and the old 2px row
      // gap stacked two bordered pills nearly touching (5.77px of ink across, 2px down).
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {target}
        <ProfileGridSelector
          groups={profileGroups}
          agentSettings
          // `pickerModel`, not `model`: an ACP row is keyed on the bare agent slug; the model inside
          // the agent is the dropdown's, below.
          value={{ provider: resolved.backend, model: resolved.pickerModel, effort: resolved.effort }}
          onValueChange={choose}
          ariaLabel="Model and effort"
          title={resolved.modelAvailable && resolved.effortAvailable
            ? "Model and reasoning effort"
            : "Saved model or reasoning effort unavailable — choose a supported pair"}
          className="max-w-[min(21rem,72vw)]"
        />
        {acpAgent && (
          <AcpModelSelect
            agentId={acpAgent.id}
            agentLabel={acpAgent.label}
            modelId={resolved.acpModelId}
            onValueChange={(modelId) => chooseAcpModel(acpAgent.id, modelId)}
            className="max-w-[min(14rem,40vw)] px-2 py-1"
          />
        )}
        {picked && defaultResolved && (
          <MakeDefaultButton groups={profileGroups} pick={resolved} defaultProfile={defaultResolved} onClick={makeDefault} />
        )}
        {/* The thread's time limit, another setting of the thread about to start (DeadlineControl). */}
        <DispatchTimeLimit draftKey={limitKey} />
      </div>
    )
  }, [resolved, defaultResolved, picked, codexList, claudeList, acpList, profileLoadError, choose, chooseAcpModel, makeDefault, target, limitKey, terminalMode, terminalDir])

  // ⌥⇧↑/↓ in the box: the picker's next effort for the model it shows (lib/keybindings.ts EFFORT_STEP_CHORDS).
  const stepEffort = (step: 1 | -1) => {
    if (!resolved) return
    const groups = dispatchProfileGroups(codexList, acpList, claudeList)
    const next = stepProfileGridEffort(groups, { provider: resolved.backend, model: resolved.pickerModel, effort: resolved.effort }, step)
    if (next) choose(next)
  }

  return (
    <div ref={rootRef} className="w-full flex flex-col gap-3">
      <Composer
        surface="newComposer"
        autoFocus={autoFocus}
        value={prompt}
        onChange={onPromptChange}
        onSubmit={submit}
        marks={schedule.marks}
        onInputEvent={schedule.onInputEvent}
        onEscape={schedule.onEscape}
        sendGlyph={terminalMode ? undefined : schedule.sendGlyph}
        sendTitle={terminalMode ? "Run in a terminal" : schedule.sendTitle}
        sendPending={schedule.sendPending}
        contextTokens={contextTokens}
        contextSources={contextSources}
        header={<EditorContextBar box={{ key: promptKey, projectDir, surface: "newComposer" }} />}
        aside={<EditorLine box={{ key: promptKey, projectDir, surface: "newComposer" }} />}
        placeholder="Describe the task…"
        mentionCandidates={mentions}
        fileMentions={embedFileMentions(projectDir)}
        slashSuggest={slashSuggest}
        slashSuggestVersion={userCommandsQuery.dataUpdatedAt}
        minHeight={96}
        maxHeight={340}
        busy={dispatch.isPending || startTerminal.isPending || savingSettings}
        onUploadingChange={setUploading}
        footer={footer}
        onEffortStep={stepEffort}
        onLeadingProject={leadingProject}
      />
      {/* THE ONE SLOT under the box: the schedule strip, or a line about the schedule (ScheduleComposer.tsx).
          Pulled up by the column's own gap so it hangs from the box's bottom edge; its row opens from 0fr, so
          the list below slides rather than jumping, and folds the same way. Always mounted: the live region
          in it must exist before the line it announces. */}
      <div
        data-schedule-slot-wrap
        data-open={schedule.slotOpen || undefined}
        className={`-mt-3 grid transition-[grid-template-rows] duration-[140ms] ease-out motion-reduce:transition-none ${schedule.slotOpen ? "grid-rows-[1fr] delay-[60ms]" : "grid-rows-[0fr]"}`}
      >
        {/* A slot folding away is a picture of what WAS: it stays mounted for its fold with the handlers of
            the state it was drawn in, so it is inert while it folds — no press, no focus, nothing read out. */}
        <div className="min-h-0 overflow-hidden" inert={!schedule.slotOpen}>{schedule.slot}</div>
        <span className="sr-only" role="status" aria-live="polite">{schedule.announcement}</span>
      </div>
      {dispatch.isError && (
        <span className="px-0.5 text-[11px] text-danger truncate">{(dispatch.error as Error).message}</span>
      )}
      {pendingDispatch && (
        <div data-pending-dispatch role="status" className="rounded-lg border border-border bg-panel-2 px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            <span>Starting thread…</span>
          </div>
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-fg">{pendingDispatch}</p>
        </div>
      )}
      {signInFor && (
        <SignInModal
          backend={signInFor}
          onClose={() => setSignInFor(null)}
          onAuthed={() => {
            const input = gatedInputRef.current
            gatedInputRef.current = null
            setSignInFor(null)
            if (input) runDispatch(input)
          }}
        />
      )}
      {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
    </div>
  )
}

// The anywhere-modal behind the pill button: same form in a centered dialog. Esc closes (captured
// here BEFORE the composer's own Escape-blurs handler can swallow it).
export function NewThreadDialog({ onClose }: { onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null)
  // Over whatever drawers are open — `c`, the palette's New thread or an editor's New thread button all
  // open it on top of a thread (lib/overlaySurface.ts aboveDrawersZ, which says why not z-[200]).
  const z = aboveDrawersZ(useSnapshot(store).drawers.length)
  // ntwine opens this dialog by writing store state, not through RadixDialog.Trigger. Capture the real
  // opener during the mount render so close can restore it explicitly.
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  useEffect(() => () => {
    const opener = openerRef.current
    window.setTimeout(() => {
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }, 0)
  }, [])
  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <RadixDialog.Portal>
        {/* Frosted glass: heavy blur + saturation over a light black wash, so the board reads as a
            texture behind the dialog rather than going fully dark. */}
        <RadixDialog.Overlay className="fixed inset-0 bg-scrim-30 backdrop-blur-md backdrop-saturate-150" style={{ zIndex: z }} />
        <RadixDialog.Content
          ref={contentRef}
          aria-modal="true"
          aria-describedby={undefined}
          onEscapeKeyDown={handleDialogEscape}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const opener = openerRef.current
            if (opener?.isConnected) opener.focus({ preventScroll: true })
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true })
          }}
          // TOP-ANCHORED ON A PHONE. Vertically centred, this dialog sits at ~420pt on a 844pt screen —
          // which is under the keyboard the moment its textarea takes focus, and the composer is the
          // entire point of the dialog. Above the phone breakpoint nothing changes.
          style={{ zIndex: z + 1 }}
          className="fixed left-1/2 top-1/2 w-[640px] max-w-[86vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-shadow-ink/50 outline-none max-[700px]:top-[calc(env(safe-area-inset-top)+56px)] max-[700px]:w-[calc(100vw-24px)] max-[700px]:max-w-none max-[700px]:translate-y-0"
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">New thread</RadixDialog.Title>
          <DispatchForm autoFocus onDispatched={onClose} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    // Frosted glass: heavy blur + saturation over a light black wash, so the board reads as a
    // texture behind the dialog rather than going fully dark. z-[200] matches the shared Radix Dialog
    // tier so the centered picker sits ABOVE the sidebar/prompt box (z-[100] on desktop) rather than
    // behind it.
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-scrim-30 backdrop-blur-md backdrop-saturate-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {children}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  )
}
