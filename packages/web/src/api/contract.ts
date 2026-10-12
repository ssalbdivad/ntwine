// The client's view of the server's RPC surface — the ONE declaration every browser call site is
// checked against.
//
// WHY THIS FILE IS SEPARATE FROM rpc.ts (and why it may only contain types + plain data):
// it is compiled a SECOND time, by the server package's typecheck, where `packages/server/src/
// rpc-contract.ts` proves — procedure by procedure — that every declaration below is EXACTLY the
// zod `input`/`output` of the real router. That is the structural gate that replaced the old
// hand-mirroring hazard: a server schema change the client does not satisfy now fails
// `npm run typecheck` instead of surfacing as a runtime toast in the operator's face
// ("Couldn't finish: sessionId: Required").
//
// The gate only works while this module stays importable from a NODE program with no DOM lib and no
// browser globals. So: `import type` only, no runtime imports, no `location`/`fetch`/`window`, and
// nothing but the `PROCEDURES` data table as a value. Transport concerns (fetch, RpcCallOpts, the
// Proxy) live in rpc.ts, which is browser-only and never enters the server program.
import type {
  CreateScheduleInput,
  GetScheduleResult,
  InterpretScheduleInput,
  InterpretScheduleResult,
  ListSchedulesInput,
  OwnScheduleInput,
  OwnScheduleResult,
  ReportClientZoneInput,
  RunScheduleNowResult,
  ScheduleIdInput,
  ScheduleView,
  SetScheduleStateInput,
  UpdateScheduleInput,
  StartHeldThreadInput,
  UpdateHeldPromptInput,
  EditorComposeInput,
  EditorComposeItem,
  EditorFront,
  EditorReviewTarget,
  EditorStateResult,
  EditorWindowSummary,
  BackgroundShellOutputInput,
  BackgroundShellOutputResult,
  WorkflowAgentView,
  StartTerminalInput,
  TerminalInput,
  RunTerminalInput,
  StartTerminalResult,
  ThreadWorkingDir,
  ThreadStats,
  ProjectQueue,
  ThreadHandoff,
  UpsertOwnLinkInput,
  UpsertOwnLinkResult,
  DropOwnLinkInput,
  DropOwnLinkResult,
  BoardSnapshot,
  Settings,
  DispatchInput,
  AdoptThreadInput,
  AdoptThreadResult,
  FollowUpInput,
  SpinoffInput,
  SpinoffResult,
  UnqueueFollowUpInput,
  UnqueueFollowUpResult,
  DismissFailedFollowUpInput,
  DismissFailedFollowUpResult,
  DeliverQueuedNowInput,
  DeliverQueuedNowResult,
  CompactThreadInput,
  RenameThreadInput,
  AiRenameThreadResult,
  SetThreadPermissionInput,
  SetThreadPermissionResult,
  ThreadProfileOptionsInput,
  ThreadSkillsInput,
  UserCommandsResult,
  SaveUserCommandInput,
  DeleteUserCommandInput,
  ThreadSkillsResult,
  ThreadProfileOptionsResult,
  SetThreadProfileInput,
  SetThreadProfileResult,
  UpgradeThreadModelInput,
  UpgradeThreadModelResult,
  SetThreadRecurringPromptInput,
  SetOwnThreadRecurringPromptInput,
  SetOwnThreadRecurringPromptResult,
  SetOwnThreadTitleInput,
  SetOwnThreadTitleResult,
  ReadThreadInput,
  ReadThreadResult,
  SubAgentDirectory,
  MessageThreadInput,
  MessageThreadResult,
  GetOwnThreadRecurringPromptInput,
  OwnThreadRecurringPromptResult,
  SetOwnThreadStopHookInput,
  SetOwnThreadHeartbeatInput,
  SetOwnThreadTimerInput,
  SetOwnThreadTimerResult,
  CancelOwnThreadTimerInput,
  CancelOwnThreadTimerResult,
  ListOwnThreadTimersInput,
  ListOwnThreadActivityInput,
  OwnThreadActivityResult,
  OwnThreadTimersResult,
  ThreadPluginReloadResult,
  SetThreadPinnedInput,
  SetThreadSnoozeInput,
  TranscriptMessage,
  TranscriptPage,
  TranscriptEarlierInput,
  GithubStatus,
  GithubListResult,
  GithubBatchInput,
  GithubBatchResult,
  GithubRefPreviewResult,
  ClaudeModel,
  CodexModel,
  AcpAgent,
  AcpAgentModels,
  AcpAgentModelsInput,
  QuotaSnapshot,
  AuthSnapshot,
  AccountLogoutInput,
  AccountLogoutResult,
  DispatchPreferences,
  SetDispatchPreferenceInput,
  ListInteractionsInput,
  ListInteractionsResult,
  GetInteractionInput,
  GetInteractionResult,
  ResolveInteractionInput,
  ResolveInteractionResult,
  CancelInteractionInput,
  CancelInteractionResult,
  CompletionHold,
  ProjectCard,
  ProjectRailCounts,
  ThreadLocation,
  DirectoryPickResult,
  ProjectAddResult,
  ProjectPickResult,
  AddOwnPrWatchInput,
  WatchDoneRefInput,
  WatchDoneRefResult,
  AddOwnWatchInput,
  AddOwnWatchResult,
  ExtendOwnShellInput,
  OwnDeadlineInput,
  OwnDeadlineResult,
  SetThreadDeadlineInput,
  SetRunningDeadlinesInput,
  SetRunningDeadlinesResult,
  ThreadDeadlineView,
  ExtendOwnShellResult,
  DropOwnWatchInput,
  DropOwnWatchResult,
  AskInput,
  AskResult,
  MarkOwnDoneInput,
  MarkOwnDoneResult,
  UnaskInput,
  UnaskResult,
  AnswerQuestionsInput,
  AnswerQuestionsResult,
  DismissQuestionsInput,
  DismissQuestionsResult,
  HoldQuestionDefaultInput,
  HoldQuestionDefaultResult,
  ThreadSettledQuestionsResult,
  AddOwnPrWatchResult,
  DropOwnPrWatchInput,
  DropOwnPrWatchResult,
  ListOwnPrWatchesInput,
  OwnPrWatchesResult,
} from "@frizz/shared"

// Per-call transport options — declared here (not in rpc.ts) only because two procedures name it in
// their signature. It is a CLIENT-side extension: the drift gate compares `Parameters<…>[0]`, so an
// extra trailing optional argument is deliberately invisible to it.
export interface RpcCallOpts {
  signal?: AbortSignal
}

/** One folder "Open in editor" can offer (server router.ts threadFolderChoices): the thread's own, or a
 *  checkout its recent sub-agents work in. `agents` counts the recent sub-agents there; `newest` is the
 *  newest one's description. */
export interface ThreadFolderChoice {
  dir: string
  thread: boolean
  agents: number
  newest?: string
}

export interface Api {
  board(): Promise<BoardSnapshot>
  threadBody(input: { slug: string }): Promise<{ markdown: string }>
  threadTranscript(input: { slug: string }): Promise<TranscriptPage>
  // A resting thread's final assistant message and the human's last one — the All queues page's card
  // body. Called PROJECT-BOUND (`/_frizz/<projectId>/rpc`), like every per-thread verb that page uses.
  threadHandoff(input: { slug: string }): Promise<ThreadHandoff>
  threadTranscriptEarlier(input: TranscriptEarlierInput): Promise<TranscriptPage>
  // The thread's answered registered questions, which the transcript keeps drawing where they stood.
  threadSettledQuestions(input: { slug: string }): Promise<ThreadSettledQuestionsResult>
  // `steerable` is the server's answer to "can this child be prompted right now" — a broker-backed
  // claude thread's own live Agent-tool child, and nothing else. The drawer renders its prompt box
  // if and only if this is true; the client never re-derives the policy.
  subAgentTranscript(input: { slug: string; id: string }): Promise<{ messages: TranscriptMessage[]; state: "running" | "stale" | "done" | "gone"; steerable: boolean; steerNote: string | null; stoppable: boolean; stopNote: string | null; workflow?: WorkflowAgentView[] }>
  // EVERY sub-agent the thread ever dispatched — live first, then the returned ones newest first — with
  // each one's `thread.child` address. What `@thread.` completes against in the prompt box and what a
  // `@thread.child` mention opens; the board's `subAgents` is the live list only.
  subAgentDirectory(input: { slug: string }): Promise<SubAgentDirectory>
  // Worker-side only (the post-dispatch hook); declared so the contract covers every procedure.
  subAgentAddressFor(input: { slug: string; label: string }): Promise<{ address?: string }>
  // Deliver a steer INTO one running sub-agent's own conversation (not the thread's main turn).
  // Throws when the child settled first — see the router's subAgentSteer for why that must fail loudly.
  subAgentSteer(input: { slug: string; id: string; message: string; deliveryId?: string }): Promise<{ delivered: boolean }>
  // Ends the child AND its whole live subtree — a stop names one task, and the provider's registry is
  // flat, so anything less orphans the grandchildren. `descendantsStopped` counts the extra tasks
  // ended; `note` narrates the fan-out, including any descendant that could NOT be stopped.
  subAgentStop(input: { slug: string; id: string }): Promise<{ stopped: boolean; descendantsStopped: number; note: string | null }>
  backgroundShellOutput(input: BackgroundShellOutputInput): Promise<BackgroundShellOutputResult>
  // The ops strip's live output counter, batched over every shell row it is showing. `lines: null` is
  // "no readable output yet" (a shell still between its tool_use and its launch ack) — never zero, and
  // never an omission, which would stop the poll before the path ever arrived.
  backgroundShellActivity(input: { slug: string; ids: string[] }): Promise<{ shells: { id: string; lines: number | null; running: boolean }[] }>
  // The × on a live sub-agent / background-shell row. It MEANS stop: the server tries the real
  // provider control first and only then retires the row. `stopped` says whether work was actually
  // terminated; `note` is why it could not be, when there is a reason worth telling the operator —
  // without it the row would vanish while the child kept running, which is the whole bug this
  // endpoint replaced. `dismissed:false` when the id was no longer live to retire. The stop covers the
  // child's whole live SUBTREE (`descendantsStopped` counts the rest), because stopping only the named
  // row left its grandchildren running and still reporting into this thread.
  stopBackgroundOp(input: { slug: string; id: string }): Promise<{ stopped: boolean; dismissed: boolean; note: string | null; descendantsStopped: number }>
  // Scoped typed requests are read/answered only for the current registered session. There is
  // deliberately no browser create method: provider adapters alone can journal a request.
  pendingInteractions(input: ListInteractionsInput): Promise<ListInteractionsResult>
  interactionGet(input: GetInteractionInput): Promise<GetInteractionResult>
  interactionResolve(input: ResolveInteractionInput): Promise<ResolveInteractionResult>
  interactionCancel(input: CancelInteractionInput): Promise<CancelInteractionResult>
  dispatch(input: DispatchInput): Promise<{ slug: string; sessionId: string }>
  adoptThread(input: AdoptThreadInput): Promise<AdoptThreadResult>
  // `opts` carries the send deadline. A follow-up is the one mutation that can be held open
  // indefinitely by a server-side wait, and it runs inside a per-slug FIFO — see
  // lib/eagerComposerSubmission.ts DELIVERY_SEND_TIMEOUT_MS for what that costs without one.
  followUp(input: FollowUpInput, opts?: RpcCallOpts): Promise<void>
  spinoff(input: SpinoffInput): Promise<SpinoffResult>
  // Held threads (ThreadView.held): a thread written down without an agent — a schedule's next run —
  // its opening prompt edited, and its agent started.
  updateHeldPrompt(input: UpdateHeldPromptInput): Promise<void>
  startHeldThread(input: StartHeldThreadInput): Promise<{ slug: string; sessionId: string }>
  unqueueFollowUp(input: UnqueueFollowUpInput): Promise<UnqueueFollowUpResult>
  // The × (and Edit) on a FAILED send's bubble — see DismissFailedFollowUpInput.
  dismissFailedFollowUp(input: DismissFailedFollowUpInput): Promise<DismissFailedFollowUpResult>
  // The ↑ on a queued bubble: stop waiting and make the worker read what is already queued. No message
  // payload — see DeliverQueuedNowInput.
  deliverQueuedNow(input: DeliverQueuedNowInput): Promise<DeliverQueuedNowResult>
  // "Compact now" in the context meter's hover panel — see CompactThreadInput.
  compactThread(input: CompactThreadInput): Promise<void>
  setThreadPermission(input: SetThreadPermissionInput): Promise<SetThreadPermissionResult>
  threadProfileOptions(input: ThreadProfileOptionsInput): Promise<ThreadProfileOptionsResult>
  // The composer's `/` typeahead: the thread's invocable skills, as its own harness reports them.
  // Any failure (no live session, a legacy row) means "no suggestions", never a surfaced error.
  threadSkills(input: ThreadSkillsInput): Promise<ThreadSkillsResult>
  userCommands(): Promise<UserCommandsResult>
  saveUserCommand(input: SaveUserCommandInput): Promise<void>
  deleteUserCommand(input: DeleteUserCommandInput): Promise<void>
  setThreadProfile(input: SetThreadProfileInput): Promise<SetThreadProfileResult>
  upgradeThreadModel(input: UpgradeThreadModelInput): Promise<UpgradeThreadModelResult>
  markRead(input: { slug: string }): Promise<void>
  // Opening a thread records read/seen telemetry only. Queue membership is lifecycle-driven and is
  // never cleared by viewing a resting thread. No-op for a foreign thread (no registry row).
  threadSeen(input: { slug: string }): Promise<void>
  // The ONLY writer of a session thread's open|archived lifecycle (the done fence mutates nothing).
  setThreadState(input: { slug: string; state: "open" | "archived" }): Promise<void>
  // Completes an inactive session immediately. A live provider shell reports that confirmation is
  // required; the caller must opt into its termination before the row can move to Done. `hold` carries
  // WHY it declined — the executing turn and/or the named live sub-agents/shells — for the dialog to name.
  // `sessionId` binds the click to the session the tab was looking at: a stale tab fails closed rather
  // than completing whatever now owns the slug.
  completeThread(input: { slug: string; sessionId: string; terminateLive?: boolean }): Promise<{ needsConfirmation: boolean; hold?: CompletionHold }>
  setThreadSnooze(input: SetThreadSnoozeInput): Promise<void>
  // Pin/unpin the thread out of the rail's band system (the pinned band at the top of the rail).
  setThreadPinned(input: SetThreadPinnedInput): Promise<void>
  // THE RECURRING PROMPT, armed entirely from the Goal panel: one text, and up to two triggers
  // (every rest, and/or every N minutes). Text, triggers and cadence travel together — they are one row.
  setThreadRecurringPrompt(input: SetThreadRecurringPromptInput): Promise<void>
  // The WORKER-facing counterpart, called by `mcp__frizz__goal` rather than by this client.
  // Declared here because rpc-contract.ts proves the two procedure NAME SETS are equal — an RPC the
  // client cannot name is one nothing checks the shape of. No browser call site uses it.
  setOwnThreadRecurringPrompt(input: SetOwnThreadRecurringPromptInput): Promise<SetOwnThreadRecurringPromptResult>
  // The READ half of the same tool (`action: "get"`), so a worker can see the row before it overwrites
  // it — after a compaction, or after the human edited the text in the Goal panel.
  getOwnThreadRecurringPrompt(input: GetOwnThreadRecurringPromptInput): Promise<OwnThreadRecurringPromptResult>
  // THE WORKER NAMING ITS OWN THREAD, called by `mcp__frizz__title`. Declared here for the drift gate
  // alone — the browser's rename verbs are `renameThread` / `aiRenameThread`, which lock the name.
  setOwnThreadTitle(input: SetOwnThreadTitleInput): Promise<SetOwnThreadTitleResult>
  readThread(input: ReadThreadInput): Promise<ReadThreadResult>
  messageThread(input: MessageThreadInput): Promise<MessageThreadResult>
  // THE PR WATCHER REGISTRY, called by `mcp__frizz__watch_pr` rather than by this client. Declared here
  // for the same reason as its neighbours: rpc-contract.ts proves the two procedure NAME SETS are equal,
  // so an RPC the client cannot name is one nothing checks the shape of. No browser call site uses these.
  addOwnPrWatch(input: AddOwnPrWatchInput): Promise<AddOwnPrWatchResult>
  dropOwnPrWatch(input: DropOwnPrWatchInput): Promise<DropOwnPrWatchResult>
  listOwnPrWatches(input: ListOwnPrWatchesInput): Promise<OwnPrWatchesResult>
  // THE WORKER'S OWN WATCHES on its own running work, called by `mcp__frizz__watch` / `unwatch`. Same
  // story as the PR watchers above: declared for the drift gate, never called from the browser.
  addOwnWatch(input: AddOwnWatchInput): Promise<AddOwnWatchResult>
  // `mcp__frizz__extend_shell` — a background shell's runtime budget. Drift gate only, like its neighbours.
  extendOwnShell(input: ExtendOwnShellInput): Promise<ExtendOwnShellResult>
  // `mcp__frizz__deadline` — the worker's own time limit. Drift gate only, like its neighbours.
  ownDeadline(input: OwnDeadlineInput): Promise<OwnDeadlineResult>
  threadDeadline(input: { slug: string }): Promise<OwnDeadlineResult>
  // The drawer's time-limit control: set, move or clear (`deadline: null`) the thread's deadline.
  setThreadDeadline(input: SetThreadDeadlineInput): Promise<{ deadline: ThreadDeadlineView | null }>
  setRunningDeadlines(input: SetRunningDeadlinesInput): Promise<SetRunningDeadlinesResult>
  upsertOwnLink(input: UpsertOwnLinkInput): Promise<UpsertOwnLinkResult>
  dropOwnLink(input: DropOwnLinkInput): Promise<DropOwnLinkResult>
  dropOwnWatch(input: DropOwnWatchInput): Promise<DropOwnWatchResult>
  // THE WORKER'S REGISTERED QUESTIONS. `ask`/`unask` are the worker's and are declared here for the
  // drift gate alone; the two below ARE called from the browser — they are what the question card does.
  ask(input: AskInput): Promise<AskResult>
  unask(input: UnaskInput): Promise<UnaskResult>
  // The worker's gated completion verb. Declared here for the drift gate's sake — the browser never
  // calls it, exactly as it never calls `ask`.
  markOwnDone(input: MarkOwnDoneInput): Promise<MarkOwnDoneResult>
  // The card's Send: every question it holds an answer for, in ONE call, because a per-question send
  // would half-wake a turn.
  answerQuestions(input: AnswerQuestionsInput): Promise<AnswerQuestionsResult>
  // The card's ×. It never wakes the worker — the human dismissing questions is almost always
  // dismissing several in a row, so a wake per click would be a turn per click; the worker is told at
  // its next wake instead. Refused server-side for a danger-tagged question, which the card also does
  // not offer it on.
  dismissQuestions(input: DismissQuestionsInput): Promise<DismissQuestionsResult>
  holdQuestionDefault(input: HoldQuestionDefaultInput): Promise<HoldQuestionDefaultResult>
  // THE SUPERSEDED WORKER PROCEDURES, declared here only so the drift gate can see them. A worker's MCP
  // server outlives every frizz restart, so a session dispatched before the stop hook and the heartbeat
  // merged is still POSTing these names; the router aliases them onto the one recurring-prompt row
  // (`applyLegacyWorkerTrigger`). No browser call site uses them, and none should — the gate proves the
  // two procedure NAME SETS are equal, so an alias the client cannot name is an alias nothing checks.
  setOwnThreadStopHook(input: SetOwnThreadStopHookInput): Promise<void>
  setOwnThreadHeartbeat(input: SetOwnThreadHeartbeatInput): Promise<void>
  setThreadHeartbeat(input: SetOwnThreadHeartbeatInput): Promise<void>
  // THE ONE-OFF TIMERS, called by `mcp__frizz__timer` rather than by this client. Declared here for the
  // same reason as the worker procedures above — the drift gate proves the two procedure NAME SETS are
  // equal, so an RPC the client cannot name is one nothing checks the shape of. All three are mutations
  // because the worker's MCP server POSTs every call; `listOwnThreadTimers` reads nothing and is one
  // anyway. No browser call site uses them.
  setOwnThreadTimer(input: SetOwnThreadTimerInput): Promise<SetOwnThreadTimerResult>
  cancelOwnThreadTimer(input: CancelOwnThreadTimerInput): Promise<CancelOwnThreadTimerResult>
  listOwnThreadTimers(input: ListOwnThreadTimersInput): Promise<OwnThreadTimersResult>
  listOwnThreadActivity(input: ListOwnThreadActivityInput): Promise<OwnThreadActivityResult>
  // In-place plugin reload for a broker-backed Claude thread — the alternative to a hard restart.
  reloadThreadPlugins(input: { slug: string; sessionId: string }): Promise<ThreadPluginReloadResult>
  // Event-snooze the awaiting-background card: hide it until the thread's own background work returns
  // (the parent comes to a NEW rest). No deadline and no scheduler — the board re-surfaces it the moment
  // rested_at advances. `sessionId` binds the click to the session the tab was looking at.
  // `clear` undoes it (the queue card's toast).
  snoozeAwaitingBackground(input: { slug: string; sessionId: string; clear?: boolean }): Promise<void>
  // The done card's Watch button: watch a PR or issue the finished thread names, and snooze it until it reports.
  watchDoneRef(input: WatchDoneRefInput): Promise<WatchDoneRefResult>
  // Hide the thread until ALL its running sub-agents have returned: each return still wakes the parent,
  // but only the last one (or a question, a crash, a done) re-queues it. Refused with none running.
  snoozeUntilSubAgentsReturn(input: { slug: string; sessionId: string; clear?: boolean }): Promise<void>
  // Wake a parked thread now with its check-in, as the hourly expiry would, asking it to report.
  requestParkCheckIn(input: { slug: string; sessionId: string }): Promise<void>
  // Hard-delete any thread (a live worker is stopped first): its rows, its terminals, its scratch
  // directory. Frees its slug and @handle (server router.ts deleteOwnedThread).
  deleteThread(input: { slug: string }): Promise<void>
  // Server-authoritative, shell-safe provider resume command for a registered Frizz-owned session.
  // A live Frizz-owned runtime is deliberately unavailable: a second provider client is uncoordinated.
  threadTerminalCommand(input: { slug: string }): Promise<{ command: string | null; mode: "attach" | "resume" | "unavailable"; reason: string | null }>
  openExternal(input: { url: string }): Promise<void>
  // `line`/`column`/`endLine` land the Local file links app on a place in the file: through a connected editor
  // window (the editor bridge, packages/vscode) when the app is one, else its CLI's `-g path:line:col`.
  openLocalFile(input: { path: string; image?: boolean; line?: number; column?: number; endLine?: number }): Promise<{ action: "opened" | "copy"; path: string }>
  // "Open in editor": the thread's working folder, in the Local file links app when it is an editor, else $EDITOR.
  // When its sub-agents work in other checkouts it opens nothing and answers `choices`; the pick comes
  // back as `path`, which must be one of them.
  openThreadFolder(input: { slug: string; path?: string }): Promise<{ path?: string; choices?: ThreadFolderChoice[] }>
  // The same for the project's own folder — `e` with no thread in front of the human.
  openProjectFolder(input: Record<never, never>): Promise<{ path: string }>
  // A disk-local Markdown file's source, for the built-in reader drawer. Openable-root gated and
  // extension-locked server-side; `truncated` marks a file cut at the read ceiling.
  localMarkdown(input: { path: string }): Promise<{ path: string; markdown: string; truncated: boolean }>
  localFile(input: { path: string }): Promise<{ path: string; text: string; truncated: boolean }>
  // Classify path references (as they appear in inline code) → canonical openable path, or null when the
  // candidate doesn't resolve to a real file under the server's openable roots. Drives clickable inline code.
  resolveLocalPaths(input: { paths: string[]; base?: string }): Promise<{ resolved: { input: string; path: string | null }[] }>
  settleLocalPath(input: { path: string }): Promise<{ path: string }>
  // Editor windows connected over the editor bridge (machine-wide; the `editors` event pushes changes).
  editorWindows(): Promise<{ windows: EditorWindowSummary[] }>
  // A thread's changes for VS Code's multi-file diff: the checkouts it wrote in (the sidebar's extension
  // reads this), and the same pushed to the editor window that should show them (a browser tab's ask).
  reviewTarget(input: { slug: string; title?: string }): Promise<EditorReviewTarget>
  reviewInEditor(input: { slug: string; title?: string }): Promise<{ ok: true }>
  // Claim what an editor sent to the prompt box (machine-wide, first caller wins). No id: the oldest.
  composeTake(input: { id?: string }): Promise<{ item: EditorComposeItem | null }>
  // What the editor windows that have this project open show: file in front, selection, tabs, problems.
  // The workers' `mcp__frizz__editor` reads it; the page does not.
  editorState(input: { slug?: string }): Promise<EditorStateResult>
  // Which capability-gated tools the workers' frizz MCP server lists (`editor` while a window has this
  // project open). The worker's MCP server polls it; the page does not.
  workerCapabilities(input: { slug?: string }): Promise<{ editor: boolean }>
  // What a browser tab shows of the editor beside it: the file in front and its selection's lines, from
  // the window this project's agents' editor tool reads; `text` adds what a click puts in the prompt box.
  editorFront(input: { text?: boolean }): Promise<{ front: EditorFront | null; item?: EditorComposeInput }>
  markComplete(input: { slug: string }): Promise<void>
  setThreadStatus(input: { slug: string; status: "active" | "planning" | "planned" | "needs-human" | "blocked" | "done" | "dismissed" }): Promise<void>
  dismissThread(input: { slug: string }): Promise<void>
  repairThread(input: { file: string }): Promise<{ slug: string }>
  archiveThread(input: { slug: string }): Promise<void>
  killAgent(input: { slug: string }): Promise<void>
  renameThread(input: RenameThreadInput): Promise<void>
  aiRenameThread(input: { slug: string }): Promise<AiRenameThreadResult>
  // The selectable Codex models + per-model effort options, read server-side from the authoritative
  // ~/.codex/models_cache.json (never a hand-maintained list). The model picker's Codex section and its
  // effort dropdown are driven by this; a tiny client fallback covers the loading/no-cache state.
  codexModels(): Promise<CodexModel[]>
  // The Claude aliases with the edition the pinned runtime resolves each to ("Opus 5.5"). The picker's
  // Claude rows take their labels from this; the bare family words cover loading and an older server.
  claudeModels(): Promise<ClaudeModel[]>
  // The ACP agents Frizz can launch, with `available` for the ones on the server's PATH. The composer
  // lists the available ones as `acp:<id>` models (plans/acp-backend.md).
  acpAgents(): Promise<AcpAgent[]>
  // The models one ACP agent advertises (a throwaway session, cached server-side). Asked only when a
  // model picker for that agent is open.
  acpAgentModels(input: AcpAgentModelsInput): Promise<AcpAgentModels>
  // Provider subscription quota (5h + weekly windows) for the sidebar status bar. `force` bypasses
  // the shared freshness window for an explicit user recheck.
  quota(input?: { force?: boolean }, opts?: RpcCallOpts): Promise<QuotaSnapshot>
  // Per-provider LOCAL credential presence for the new-thread dispatch gate. Distinct from quota's
  // overloaded "unavailable" — reports only whether a credential exists. Never rejects.
  authStatus(input?: undefined, opts?: RpcCallOpts): Promise<AuthSnapshot>
  accountLogout(input: AccountLogoutInput): Promise<AccountLogoutResult>
  // A thread's TERMINALS (server thread-terminals.ts): where a new one would start, and its verbs.
  threadWorkingDir(input: { slug: string }): Promise<ThreadWorkingDir>
  // The ⋯ menu's Thread info: what the thread has consumed (server thread-stats.ts).
  threadStats(input: { slug: string }): Promise<ThreadStats>
  terminalStart(input: StartTerminalInput): Promise<StartTerminalResult>
  terminalStop(input: TerminalInput): Promise<Record<never, never>>
  terminalRestart(input: TerminalInput): Promise<Record<never, never>>
  terminalRun(input: RunTerminalInput): Promise<Record<never, never>>
  terminalRemove(input: TerminalInput): Promise<Record<never, never>>
  // Machine-scoped: the registry is one file, so the project list reads the same from every project.
  // Which project owns a thread slug. Every URL from the per-project era is unprefixed, so a
  // bookmark that named its project by PORT now resolves against whichever project launched the
  // server — this is how the page finds the thread instead of reporting it missing.
  threadLocate(input: { slug: string }): Promise<ThreadLocation[]>
  projectsList(): Promise<ProjectCard[]>
  // Registering a folder as a project — the add-project dialog. Same authority as running `frizz`
  // there and strictly less: it resolves an id and writes the index, and dispatches nothing.
  // Opens the machine NATIVE folder picker, server-side, and adds what comes back. The browser API
  // withholds absolute paths on purpose, and a project is a path — so the picker cannot live here.
  projectPick(input: Record<never, never>): Promise<ProjectPickResult>
  // Builds that picker ahead of the click, so the click only has to show it (macOS; `false` elsewhere).
  projectPickWarm(input: Record<never, never>): Promise<{ warming: boolean }>
  projectAdd(input: { path: string; exact?: boolean }): Promise<ProjectAddResult>
  pathComplete(input: { path: string }): Promise<{ status: "directory" | "file" | "missing" | "empty"; suggestions: string[] }>
  // The rail's squares. `projectIconSet` takes base64 from a browser file input (the bytes land in the
  // project's state dir, never in its working tree); clearing hands the square back to the automatic
  // scan, which is also what draws it in the first place — see server/project-icon.ts.
  // The rail's manual order: the whole list of ids, because the client has just laid the squares out
  // and an index pair would have to be replayed against a server order that may already differ.
  projectsReorder(input: { ids: string[] }): Promise<ProjectCard[]>
  // Delete a project: Frizz's record of it, never the folder it names. Without `deleteData` this only
  // forgets the registry entry and closes the project, so adding the folder back restores the same
  // board; with it, the project's live workers are stopped and everything Frizz holds for it is
  // removed. The project Frizz is RUNNING from is refused — see the router.
  projectRemove(input: { id: string; deleteData?: boolean }): Promise<{ removed: boolean; deletedData: boolean; stoppedWorkers: number }>
  // Queue size per OPEN project, keyed by project id — the rail's badges. A project with no board on
  // this server is absent (no honest count without one), which the rail draws as no badge rather than
  // as zero. The server opens every registered project within about a second of boot, so that is a transient
  // state and not the "you have not clicked into it yet" it used to be — see server/tenant-prime.ts.
  projectsRailCounts(): Promise<Record<string, ProjectRailCounts>>
  // Every OPEN project's open threads (Queue, Running, Snoozed, Pinned) plus its Done count — the All
  // queues page. Machine-scoped like the counts above, and answered from the same open boards: a
  // project with no board here is absent. Each entry names its project, which is what every action
  // the page takes is addressed by.
  projectsQueues(): Promise<ProjectQueue[]>
  // SCHEDULED THREADS (ARCHITECTURE.md § Scheduled threads; shared schedules.ts holds every shape). Project-scoped
  // like everything else: call them through projectRpc(projectId) for a schedule in another project —
  // each ScheduleView names its own projectId. `listSchedules({ allProjects: true })` is the palette's
  // cross-project list.
  listSchedules(input: ListSchedulesInput): Promise<ScheduleView[]>
  getSchedule(input: ScheduleIdInput): Promise<GetScheduleResult>
  // The prompt box's schedule mode: what the human typed → the phrase it found, the prompt with that phrase
  // cut out verbatim, the rule, and the echo to confirm. `scheduleId` makes it "Change when".
  interpretSchedule(input: InterpretScheduleInput): Promise<InterpretScheduleResult>
  createSchedule(input: CreateScheduleInput): Promise<ScheduleView>
  updateSchedule(input: UpdateScheduleInput): Promise<ScheduleView>
  // Pause / Resume / Turn on.
  setScheduleState(input: SetScheduleStateInput): Promise<ScheduleView>
  runScheduleNow(input: ScheduleIdInput): Promise<RunScheduleNowResult>
  // Delete, and a proposal's Discard.
  deleteSchedule(input: ScheduleIdInput): Promise<void>
  // Called once per page load with the browser's Intl zone.
  reportClientZone(input: ReportClientZoneInput): Promise<void>
  // The worker's `schedule` tool. Never called from the browser.
  ownSchedule(input: OwnScheduleInput): Promise<OwnScheduleResult>
  // Opens the machine's native image picker ALREADY IN the project's directory, then stores what
  // comes back. The browser input cannot be aimed anywhere, which is the whole reason this exists.
  projectIconPick(input: { id: string }): Promise<DirectoryPickResult>
  // Builds that picker when the icon menu opens, so the click only has to show it (macOS; `false` elsewhere).
  projectIconPickWarm(input: { id: string }): Promise<{ warming: boolean }>
  projectIconSet(input: { id: string; name: string; data: string }): Promise<ProjectCard>
  projectIconClear(input: { id: string }): Promise<ProjectCard>
  // Rename a project: the name on its card and the slug in its URL, and — only with
  // `renameDirectory` — the folder itself, to a sibling of the same name. The dialog offers that
  // checkbox only when the folder is already named after the project, and leaves it off.
  projectRename(input: { id: string; name: string; renameDirectory?: boolean }): Promise<ProjectCard>
  settingsGet(): Promise<Settings>
  settingsSet(input: Settings): Promise<Settings>
  // Takes an empty object, not nothing: the router declares `input: z.object({})` (a mutation always
  // has an input schema), and the transport posts `{}` for it.
  settingsReset(input: Record<never, never>): Promise<Settings>
  dispatchPreferencesGet(): Promise<DispatchPreferences>
  dispatchPreferenceSet(input: SetDispatchPreferenceInput): Promise<DispatchPreferences>
  // The shipped GitHub batch-dispatch prompt template — the Settings UI prefills its editor from this
  // and resets to it (an empty githubPrompt setting = the server default). One template, issues and PRs.
  githubPromptDefaults(): Promise<{ prompt: string }>
  // The project's FRIZZ.md, edited from the agent settings panel. A write carries the revision it was
  // based on; `ok: false` hands back the file as it now is (a worker edited it, or it is not writable).
  projectInstructionsGet(): Promise<{ content: string; revision: string; editable: boolean }>
  projectInstructionsSet(input: { content: string; baseRevision: string }): Promise<{
    ok: boolean
    reason?: "conflict" | "tooLarge" | "notAFile"
    content: string
    revision: string
  }>
  // GitHub-first batch dispatch. Detection (installed/inRepo/nameWithOwner) is cached server-side;
  // `authed` is re-checked live per call. githubList reads the repo's issues/PRs; githubDispatchBatch
  // hydrates each selected item fresh + spins up one thread per item (sequential, reuses dispatch).
  githubStatus(): Promise<GithubStatus>
  githubList(input: { kind: "issues" | "prs"; sort: "recent" | "reactions"; page?: number; perPage?: number }): Promise<GithubListResult>
  githubDispatchBatch(input: GithubBatchInput): Promise<GithubBatchResult>
  // Hovercards for the `#123` / commit-hash anchors the autolinker mints in prose. ONE call carries
  // every reference on the page so a hover reads out of the client's store instead of the network;
  // `refresh` revalidates the few the reader is actually pointing at. See lib/githubHovercards.ts.
  githubRefPreview(input: { refs: string[]; refresh?: boolean }): Promise<GithubRefPreviewResult>
}

export type ProcType = "query" | "mutation"

// The GET-vs-POST decision for every procedure. It drifts exactly as silently as the types do — a
// query flipped to a mutation server-side turns every client call into a 404/405 — so the same gate
// compares this table against each procedure's `_tag`. `as const` keeps the literal types the gate
// needs; the `satisfies` keeps it exhaustive over `Api`.
export const PROCEDURES = {
  board: "query",
  threadBody: "query",
  threadTranscript: "query",
  threadSettledQuestions: "query",
  threadHandoff: "query",
  threadTranscriptEarlier: "query",
  subAgentTranscript: "query",
  subAgentDirectory: "query",
  subAgentAddressFor: "query",
  subAgentSteer: "mutation",
  subAgentStop: "mutation",
  backgroundShellOutput: "query",
  backgroundShellActivity: "query",
  stopBackgroundOp: "mutation",
  pendingInteractions: "query",
  interactionGet: "query",
  interactionResolve: "mutation",
  interactionCancel: "mutation",
  dispatch: "mutation",
  adoptThread: "mutation",
  followUp: "mutation",
  spinoff: "mutation",
  updateHeldPrompt: "mutation",
  startHeldThread: "mutation",
  unqueueFollowUp: "mutation",
  dismissFailedFollowUp: "mutation",
  deliverQueuedNow: "mutation",
  compactThread: "mutation",
  setThreadPermission: "mutation",
  threadProfileOptions: "query",
  threadSkills: "query",
  userCommands: "query",
  saveUserCommand: "mutation",
  deleteUserCommand: "mutation",
  setThreadProfile: "mutation",
  upgradeThreadModel: "mutation",
  markRead: "mutation",
  threadSeen: "mutation",
  setThreadState: "mutation",
  completeThread: "mutation",
  setThreadSnooze: "mutation",
  setThreadPinned: "mutation",
  setThreadRecurringPrompt: "mutation",
  setOwnThreadRecurringPrompt: "mutation",
  setOwnThreadTitle: "mutation",
  readThread: "mutation",
  messageThread: "mutation",
  addOwnPrWatch: "mutation",
  dropOwnPrWatch: "mutation",
  listOwnPrWatches: "mutation",
  addOwnWatch: "mutation",
  extendOwnShell: "mutation",
  ownDeadline: "mutation",
  threadDeadline: "query",
  setThreadDeadline: "mutation",
  setRunningDeadlines: "mutation",
  upsertOwnLink: "mutation",
  dropOwnLink: "mutation",
  dropOwnWatch: "mutation",
  ask: "mutation",
  unask: "mutation",
  markOwnDone: "mutation",
  answerQuestions: "mutation",
  dismissQuestions: "mutation",
  holdQuestionDefault: "mutation",
  getOwnThreadRecurringPrompt: "mutation",
  setOwnThreadStopHook: "mutation",
  setOwnThreadHeartbeat: "mutation",
  setThreadHeartbeat: "mutation",
  setOwnThreadTimer: "mutation",
  cancelOwnThreadTimer: "mutation",
  listOwnThreadTimers: "mutation",
  listOwnThreadActivity: "mutation",
  reloadThreadPlugins: "mutation",
  snoozeAwaitingBackground: "mutation",
  watchDoneRef: "mutation",
  snoozeUntilSubAgentsReturn: "mutation",
  requestParkCheckIn: "mutation",
  deleteThread: "mutation",
  threadTerminalCommand: "query",
  openExternal: "mutation",
  openLocalFile: "mutation",
  openThreadFolder: "mutation",
  openProjectFolder: "mutation",
  localMarkdown: "query",
  localFile: "query",
  resolveLocalPaths: "query",
  settleLocalPath: "query",
  editorWindows: "query",
  reviewTarget: "query",
  reviewInEditor: "mutation",
  composeTake: "mutation",
  editorState: "mutation",
  workerCapabilities: "mutation",
  editorFront: "query",
  markComplete: "mutation",
  setThreadStatus: "mutation",
  dismissThread: "mutation",
  repairThread: "mutation",
  archiveThread: "mutation",
  killAgent: "mutation",
  renameThread: "mutation",
  aiRenameThread: "mutation",
  codexModels: "query",
  claudeModels: "query",
  acpAgents: "query",
  acpAgentModels: "query",
  quota: "query",
  authStatus: "query",
  accountLogout: "mutation",
  threadWorkingDir: "query",
  threadStats: "query",
  terminalStart: "mutation",
  terminalStop: "mutation",
  terminalRestart: "mutation",
  terminalRun: "mutation",
  terminalRemove: "mutation",
  threadLocate: "query",
  projectsList: "query",
  projectPick: "mutation",
  projectPickWarm: "mutation",
  projectAdd: "mutation",
  pathComplete: "query",
  projectsReorder: "mutation",
  projectRemove: "mutation",
  projectsRailCounts: "query",
  projectsQueues: "query",
  listSchedules: "query",
  getSchedule: "query",
  interpretSchedule: "mutation",
  createSchedule: "mutation",
  updateSchedule: "mutation",
  setScheduleState: "mutation",
  runScheduleNow: "mutation",
  deleteSchedule: "mutation",
  reportClientZone: "mutation",
  ownSchedule: "mutation",
  projectIconPick: "mutation",
  projectIconPickWarm: "mutation",
  projectIconSet: "mutation",
  projectIconClear: "mutation",
  projectRename: "mutation",
  settingsGet: "query",
  settingsSet: "mutation",
  settingsReset: "mutation",
  dispatchPreferencesGet: "query",
  dispatchPreferenceSet: "mutation",
  githubPromptDefaults: "query",
  projectInstructionsGet: "query",
  projectInstructionsSet: "mutation",
  githubStatus: "query",
  githubList: "query",
  githubDispatchBatch: "mutation",
  githubRefPreview: "query",
} as const satisfies Record<keyof Api, ProcType>
