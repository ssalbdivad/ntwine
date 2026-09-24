import * as RadixDialog from "@radix-ui/react-dialog"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useIsMutating, useMutation, useQuery } from "@tanstack/react-query"
import { acpModelSlug, type AccountBackend, type DispatchInput } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, store } from "../store.ts"
import { useSnapshot } from "valtio"
import { ArrowUp, Loader2 } from "lucide-react"
import { abbreviateHome } from "../lib/paths.ts"
import { RAIL_SEND_OFFSET } from "../lib/iconRhythm.ts"
import { Composer } from "./Composer.tsx"
import { GithubTrigger, useGithubTriggerVisible } from "./GithubTrigger.tsx"
import { ProfileGridSelector } from "./ProfileGridSelector.tsx"
import { SETTINGS_WRITE_KEY } from "../hooks/useSettingsAutosave.tsx"
import { AcpModelSelect } from "./AcpModelSelect.tsx"
import { LogoutConfirmModal, SignInModal } from "./SignInModal.tsx"
import { dispatchProfileGroups } from "../lib/dispatchPreferences.ts"
import { useDispatchProfile } from "../hooks/useDispatchProfile.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { draftKey, draftStore, useDraft, useProjectDir } from "../lib/drafts.ts"
import { projectSlug } from "../lib/base-path.ts"
import { parseAccountAlias } from "../lib/signIn.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"

// Which tab the prompt box was last on. Module-level so every mount of the box (the rail, the empty
// board, the anywhere-modal) opens where the human left it for the rest of the tab's life.
let lastDispatchMode: DispatchMode = "prompt"
export type DispatchMode = "prompt" | "terminal"

/** The tab the NEXT prompt box mounts on — how the `t` key opens the anywhere-modal straight onto
 *  Terminal (a mounted box is switched by pressing its tab instead; see App's new-thread keys). */
export function preferDispatchMode(mode: DispatchMode): void {
  lastDispatchMode = mode
}

// THE prompt box, in two tabs: PROMPT starts an agent thread, TERMINAL runs a shell command in the
// project directory as a thread of its own whose drawer is the live terminal (`npm run dev`, a test
// watcher). Shared by every surface that can start a thread: the rail, the empty board's centered
// box and the anywhere-modal.
export function DispatchForm({
  autoFocus,
  onDispatched,
  target,
}: {
  autoFocus?: boolean
  onDispatched?: () => void
  /**
   * WHERE the thread goes, when that is a choice — the cross-project page's project picker. It rides the
   * tab row's right end, the composer's own "To:" field, directly over the box it addresses. A board has
   * no choice to make and passes nothing.
   */
  target?: ReactNode
}) {
  const [mode, setModeState] = useState<DispatchMode>(lastDispatchMode)
  const setMode = (next: DispatchMode) => {
    lastDispatchMode = next
    setModeState(next)
  }
  // SWITCHING FROM THE KEYBOARD keeps the caret in the box. Claude Code's own convention, which is the
  // one every operator of this app already has in their fingers: `!` as the first character turns the
  // prompt into a shell command (its "bash mode"), and Backspace in the empty command box turns it back.
  // The tab that mounts then takes focus; a tab CLICKED with the mouse leaves focus where it was.
  const [switchedByKey, setSwitchedByKey] = useState(false)
  const switchByKey = (next: DispatchMode) => {
    setMode(next)
    setSwitchedByKey(true)
  }
  return (
    <div data-dispatch-form className="w-full flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <DispatchTabs mode={mode} onChange={(next) => { setSwitchedByKey(false); setMode(next) }} />
        {target && <div className="ml-auto flex min-w-0 items-center">{target}</div>}
      </div>
      {mode === "prompt" ? (
        <PromptForm autoFocus={autoFocus || switchedByKey} onDispatched={onDispatched} onTerminal={() => switchByKey("terminal")} />
      ) : (
        <CommandForm autoFocus={autoFocus || switchedByKey} onDispatched={onDispatched} onPrompt={() => switchByKey("prompt")} />
      )}
    </div>
  )
}

function DispatchTabs({ mode, onChange }: { mode: DispatchMode; onChange: (mode: DispatchMode) => void }) {
  const tab = (value: DispatchMode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === value}
      data-dispatch-tab={value}
      onClick={() => onChange(value)}
      // The selected tab is a bordered chip: panel-2 alone is a 2% step off the page in light mode and
      // left the selection readable only through the text colour.
      className={`rounded-md border px-2 py-0.5 text-[11.5px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${
        mode === value ? "border-border bg-panel-2 text-fg" : "border-transparent text-muted hover:text-fg"
      }`}
    >
      {label}
    </button>
  )
  return (
    <div role="tablist" aria-label="Start a thread" className="flex items-center gap-0.5 px-0.5">
      {tab("prompt", "Prompt")}
      {tab("terminal", "Terminal")}
    </div>
  )
}

// The TERMINAL tab: one shell command, run by the server in a pty in the project directory. A command
// thread is a thread like any other, so starting one behaves exactly like dispatching a prompt: you
// stay where you are, the row appears in Running, and the toast's link opens its terminal drawer.
function CommandForm({ autoFocus, onDispatched, onPrompt }: { autoFocus?: boolean; onDispatched?: () => void; onPrompt?: () => void }) {
  const projectDir = useProjectDir()
  const homeDir = useSnapshot(store).board?.homeDir
  const [command, setCommand, clearCommand] = useDraft(draftKey.command(projectDir))
  const start = useMutation({
    // The project is read when the request goes out — the one it was sent to (see ToastLink).
    mutationFn: (input: string) => {
      const project = projectSlug()
      return rpc.commandStart({ command: input }).then((res) => ({ ...res, project }))
    },
    onSuccess: (res) => {
      onDispatched?.()
      showToast("Thread started", { link: { label: "Open thread", slug: res.slug, drawer: "terminal", project: res.project } })
    },
    onError: (e, input) => {
      if (!draftStore.get(draftKey.command(projectDir))) setCommand(input)
      showToast(`Could not start the command: ${(e as Error).message.slice(0, 80)}`)
    },
  })
  function submit() {
    const trimmed = command.trim()
    if (!trimmed || start.isPending) return
    clearCommand()
    start.mutate(trimmed)
  }
  const hasContent = command.trim().length > 0
  return (
    <div className="group relative rounded-xl border border-border bg-bg transition-colors focus-within:border-accent">
      <div className="flex items-start">
        {/* The shell's own prompt mark, in the input's font, so the box reads as a command line. */}
        <span aria-hidden className="font-mono-keep select-none pl-3.5 pt-2.5 text-[13px] leading-relaxed text-muted-60">$</span>
        <textarea
          data-surface="commandComposer"
          data-claims-escape
          value={command}
          autoFocus={autoFocus}
          disabled={start.isPending}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation()
              e.currentTarget.blur()
              return
            }
            // Backspace in an EMPTY command box leaves Terminal for Prompt — how Claude Code leaves bash
            // mode (DispatchForm has the whole convention).
            if (e.key === "Backspace" && !command && onPrompt) {
              e.preventDefault()
              onPrompt()
              return
            }
            // A command is one line: Enter runs it, and Shift-Enter is not a newline worth offering.
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="npm run dev"
          rows={1}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={{ minHeight: 96, maxHeight: 340 }}
          className="font-mono-keep block w-full min-w-0 flex-1 resize-none bg-transparent py-2.5 pl-2 pr-3.5 text-[13px] leading-relaxed text-fg outline-none placeholder:text-muted scrollbar-none disabled:opacity-60"
        />
      </div>
      <div className="flex min-w-0 items-center pb-1.5 pl-3.5 pr-20">
        <span className="min-w-0 truncate py-1 text-[11px] text-muted-60" title={projectDir}>
          Runs in <span className="font-mono-keep">{projectDir ? abbreviateHome(projectDir, homeDir) : "the project directory"}</span>
        </span>
      </div>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={submit}
        disabled={!hasContent || start.isPending}
        title="Run (Enter)"
        aria-label="Run command"
        className={`icon-hover-outline absolute bottom-2 ${RAIL_SEND_OFFSET} flex h-7 w-7 items-center justify-center rounded-lg transition-all ${
          hasContent && !start.isPending ? "bg-fg text-bg hover:opacity-90 active:scale-95" : "bg-panel-2 text-muted"
        }`}
      >
        {start.isPending ? <Loader2 size={14} strokeWidth={2.5} className="animate-spin" /> : <ArrowUp size={14} strokeWidth={2.5} />}
      </button>
    </div>
  )
}

// The PROMPT tab — composer + quiet selects row. There is no title field — the server derives a
// fallback and Claude names the session itself (ai-title), which the UI prefers for display.
function PromptForm({
  autoFocus,
  onDispatched,
  onTerminal,
}: {
  autoFocus?: boolean
  onDispatched?: () => void
  /** `!` typed into the EMPTY box: switch to Terminal instead of writing it (see DispatchForm). */
  onTerminal?: () => void
}) {
  // The one durable new-thread profile, shared with the GitHub picker's own selector.
  const { resolved, codexList, acpList, loadError: profileLoadError, saveProfile } = useDispatchProfile()
  // A settings write still in flight — a compaction window picked in the model picker a moment ago —
  // must land before a dispatch that would read it.
  const savingSettings = useIsMutating({ mutationKey: [...SETTINGS_WRITE_KEY] }) > 0
  // Gate the leftAction slot itself, not just the icon: Composer reserves rail space whenever the
  // prop is set, so a hidden GithubTrigger must mean NO prop — not a null-rendering element.
  const githubTriggerVisible = useGithubTriggerVisible()
  const projectDir = useProjectDir()
  // Queue and modal are the same semantic new-thread composer.
  const [prompt, setPrompt, clearPrompt] = useDraft(draftKey.dispatch(projectDir))
  const promptKey = draftKey.dispatch(projectDir)
  const submittedDraftRef = useRef("")
  const [pendingDispatch, setPendingDispatch] = useState<string | null>(null)

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
  const dispatch = useMutation({
    mutationFn: (input: DispatchInput) => {
      const project = projectSlug()
      return rpc.dispatch(input).then((res) => ({ ...res, project }))
    },
    onMutate: () => showToast("Starting thread…", { spinner: true, sticky: true }),
    onSuccess: (res) => {
      // The board stream now owns the durable thread row. Drop our local bridge as soon as the
      // server acknowledges it, preventing an optimistic card + server card duplicate.
      setPendingDispatch(null)
      onDispatched?.()
      showToast("Thread started", { link: { label: "Open thread", slug: res.slug, project: res.project } })
    },
    onError: (e, input) => {
      // A submit clears before the RPC starts. Restore only into a still-empty field so retry is
      // effortless without overwriting text typed during the failed request.
      if (!draftStore.get(promptKey)) setPrompt(submittedDraftRef.current || input.prompt)
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
    clearPrompt()
    setPendingDispatch(input.prompt)
    dispatch.mutate(input)
  }

  function submit() {
    if (!prompt.trim() || !resolved || savingSettings) return
    // `/login` and `/logout` are frizz-owned aliases for the typed provider account actions — they
    // invoke the sign-in / sign-out flow for the SELECTED backend and never become prompt text.
    const alias = parseAccountAlias(prompt)
    if (alias) {
      clearPrompt()
      if (resolved.backend === "acp") {
        showToast("An ACP agent signs in through its own CLI — Frizz holds no account for it")
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
    if (!resolved.modelAvailable) {
      showToast("Saved model is unavailable — choose a model before starting the thread")
      return
    }
    if (!resolved.effortAvailable) {
      showToast("Saved reasoning level is unavailable for this model — choose another level")
      return
    }
    const input: DispatchInput = {
      prompt: prompt.trim(),
      // No permissionMode: the server stamps every created worker itself (workerDispatchPermission —
      // the non-interactive floor, raised to bypass only when Settings asks). Dispatch offers no
      // per-thread permission choice; the "Permissions" control behind the Claude Code gear in the model
      // picker (AgentSettingsPopover) owns the default.
      model: resolved.model,
      backend: resolved.backend,
      // An ACP profile resolves to effort "" (no effort axis); the RPC's enum takes that as ABSENT.
      // Sending "" failed every ACP dispatch from the composer with "Invalid enum value" (2026-09-16).
      effort: (resolved.effort || undefined) as DispatchInput["effort"],
    }
    // Auth gate: block ONLY on a positive "signed-out" for this dispatch's backend. Loading/unknown/
    // authed all fall through (fail open) so a flaky or slow read never blocks a logged-in user. An ACP
    // agent has no account here at all — its own CLI reports a missing login on the first prompt.
    if (resolved.backend !== "acp" && authStatus.data?.[resolved.backend] === "signed-out") {
      gatedInputRef.current = input
      setSignInFor(resolved.backend)
      return
    }
    runDispatch(input)
  }

  // The profile readout lives INSIDE the box, along its bottom edge — petite caps, very quiet.
  // Not a dropdown at rest: a plain value; hover materializes the border, click opens the menu.
  // There is no permission control: dispatch permission is fixed server-side.
  //
  // useMemo (measured in the render-perf profile): the footer used to be rebuilt inline on every
  // render, so each prompt KEYSTROKE re-rendered every picker tree — ~222 component renders per
  // keystroke. A keystroke only changes `prompt`; keeping the footer element's identity stable lets
  // React bail out of the whole control subtree, and the
  // element is rebuilt exactly when durable preference data or the model catalogue changes.
  const footer = useMemo(() => {
    if (!resolved) {
      return (
        <ProfileGridSelector
          groups={[]}
          value={undefined}
          onValueChange={() => {}}
          placeholder={profileLoadError ? "Profile unavailable" : "Profile loading…"}
          ariaLabel="Model and effort loading"
          disabled
        />
      )
    }
    const profileGroups = dispatchProfileGroups(codexList, acpList)
    const acpAgent = resolved.acpAgentId ? acpList.find((agent) => agent.id === resolved.acpAgentId) : undefined
    return (
      // gap-x-1.5 between the two pills, the same measured gap the thread composer's strip uses
      // (useThreadComposerControls): two bordered pills on `gap-x-1` read as one segmented control.
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <ProfileGridSelector
          groups={profileGroups}
          agentSettings
          // `pickerModel`, not `model`: an ACP row is keyed on the bare agent slug; the model inside
          // the agent is the dropdown's, below.
          value={{ provider: resolved.backend, model: resolved.pickerModel, effort: resolved.effort }}
          onValueChange={(selection) => saveProfile({
            field: "profile",
            backend: selection.provider as typeof resolved.backend,
            model: selection.model,
            // An ACP row has no effort cell, so its selection carries "" — stored as absent.
            effort: (selection.effort || undefined) as DispatchInput["effort"],
          })}
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
            // The pick becomes the profile's model slug (`acp:<agent>@<model>`); "" (the agent's own
            // default) drops the tail.
            onValueChange={(modelId) => saveProfile({ field: "model", backend: "acp", value: acpModelSlug(acpAgent.id, modelId) })}
            className="max-w-[min(14rem,40vw)] px-2 py-1"
          />
        )}
      </div>
    )
  }, [resolved, codexList, acpList, profileLoadError, saveProfile])

  return (
    <div className="w-full flex flex-col gap-3">
      <Composer
        surface="newComposer"
        autoFocus={autoFocus}
        value={prompt}
        // Read off the value rather than a keydown so every way of producing the `!` — a layout that
        // shifts for it, an IME, a paste of the one character — switches alike.
        onChange={(next) => {
          if (onTerminal && !prompt && next === "!") onTerminal()
          else setPrompt(next)
        }}
        onSubmit={submit}
        placeholder="Describe the task…"
        minHeight={96}
        maxHeight={340}
        busy={dispatch.isPending || savingSettings}
        footer={footer}
        leftAction={githubTriggerVisible ? <GithubTrigger /> : undefined}
      />
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
  // Frizz opens this dialog by writing store state, not through RadixDialog.Trigger. Capture the real
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
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-scrim-30 backdrop-blur-md backdrop-saturate-150" />
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
          className="fixed left-1/2 top-1/2 z-50 w-[640px] max-w-[86vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-shadow-ink/50 outline-none max-[700px]:top-[calc(env(safe-area-inset-top)+56px)] max-[700px]:w-[calc(100vw-24px)] max-[700px]:max-w-none max-[700px]:translate-y-0"
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
