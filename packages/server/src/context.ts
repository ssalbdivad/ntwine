import { mcpOnRequestSection, threadMcpGrants } from "./mcp-requests.ts"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  PermissionMode,
  wakeDeliveryToken,
  type CodexModel,
  type DispatchPreferences,
  type SetDispatchPreferenceInput,
  type Settings,
  type TranscriptMessage,
  acpModelIdFromModel,
} from "@ntwine/shared"
import { Bus, Emitter } from "./bus.ts"
import { ntwineRoots } from "./ntwine-paths.ts"
import { findById as findProjectById } from "./project-registry.ts"
import { resolveProject, permRequestDir, workDirOf, type Project } from "./project.ts"
import { isHomeWorkspace } from "./home-workspace.ts"
import { createStorage, isBrokerClaudeRow, isHeadlessRow, workerTaughtMcp, type Storage } from "./storage.ts"
import { clearSecrets } from "./secret-files.ts"
import type Database from "./sqlite.ts"
import { getSettings, setSettings, resetSettings } from "./settings.ts"
import { getDispatchPreferences, setDispatchPreference } from "./dispatch-preferences.ts"
import { readCodexModels } from "./backend/codex-models.ts"
import { readQuota } from "./quota.ts"
import { refreshClaudeQuotaInBackground } from "./backend/claude-quota.ts"
import { z } from "zod"
import { createBoard, resolveSessionTitle, telemetryVouched, type BoardManager } from "./board.ts"
import { createSessionPeerResolver, type SessionPeerThread } from "./session-peer.ts"
import { auditLogPathForStateDir, fileAuditLog, type AuditLog } from "./audit.ts"
import { createHeldThreadStarter } from "./held-start.ts"
import { createScheduleService, type ScheduleService } from "./schedules.ts"
import { createScheduleInterpreter, SCHEDULE_INTERPRETER_MODEL, type ScheduleInterpreter } from "./schedule-interpreter.ts"
import { readMachineConfig, writeMachineConfig } from "./machine-config.ts"
import { processAwakeClock } from "./awake-clock.ts"
import type { SessionRow } from "./storage.ts"
import type { HeldStartProfile } from "./held-start.ts"
import { createPeriodicStatus } from "./periodic-status.ts"
import { createLiveStatus } from "./live-status.ts"
import { createThreadNamer, openThreadsElsewhere, type ThreadNamer } from "./thread-names.ts"
import { createClaudeOneShot, type ClaudeOneShot } from "./backend/claude-oneshot.ts"
import { createEffortChooser } from "./effort-chooser.ts"
import { readTranscriptYielding } from "./transcript.ts"
import { createTailer, defaultLogDir, type Tailer } from "./tailer.ts"
import { backgroundShellStoppable, stopBackgroundShell } from "./shell-stop.ts"
import type { WorkerCapabilities } from "./workerPrompt.ts"
import { createDispatcher, loadWorkerPrompt, workerCapabilities, scratchpadOrientation, ntwineConfigBlock, claudeCliConfig, codexWorkerThreadConfig, resolveNtwineCli, resolveNtwineMcp, workerPluginDir, coldResumePermission, workerScratchPath, type Dispatcher, type NtwineMcpTarget } from "./dispatch.ts"
import { deadlineSection } from "./deadline.ts"
import { createScheduler, type Scheduler, probeIssueReadable, probePrReadable, type PrRef, type PrProbe } from "./scheduler.ts"
import {
resumeThread,
} from "./resume.ts"
import { createClaudeBackend } from "./backend/claude.ts"
import { createCodexBackend, codexSandbox } from "./backend/codex.ts"
import { createAcpBackend } from "./backend/acp-transcript.ts"
import { createAcpBridge, type AcpBridge } from "./backend/acp-bridge.ts"
import { readClaudePreflightAuth, readCodexAuthState, readCodexBinaryState } from "./backend/auth-status.ts"
import { createTerminalRunner, type TerminalRunner } from "./thread-terminals.ts"
import type { EditorBridge } from "./editor-bridge.ts"
import { ntwineCliEnv, withNtwineCliOnPath, type AgentBackend } from "./backend/types.ts"
import { sanitizeProviderChildEnvironment } from "./backend/claude-agent-sdk.ts"
import { commandWatchEnvironment, createCommandWatchService, type CommandWatchService } from "./command-watch.ts"
import { needsFreshProcessForLimit } from "./backend/usage-limit.ts"
import { onClaudeModelsResolved, peekClaudeModels, readClaudeModels } from "./backend/claude-models.ts"
import { claudeModelUpgradeDue, claudeUpgradeCandidate, SERVER_STARTED_AT_MS } from "./backend/claude-model-upgrade.ts"
import { detectGithub, type GithubDetection } from "./github.ts"
import type { InteractionStore } from "./interaction-store.ts"
import {
  codexAppServerBridgeEnabled,
  createCodexAppServerBridge,
  type CodexAppServerBridge,
  type CodexSandboxMode,
} from "./backend/codex-app-server.ts"
import { createCodexDiagnosticSink } from "./backend/codex-app-server-diagnostics.ts"
import {
  claudeBrokerBridgeEnabled,
  createClaudeAgentBrokerBridge,
  type ClaudeAgentBrokerBridge,
} from "./backend/claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest, type ClaudeRuntimeIngest } from "./backend/claude-runtime-ingest.ts"
import { describeClaudeBrokerDiagnostic, droppedDeliveryId, droppedDeliveryReason } from "./backend/claude-broker-diagnostics.ts"
import { recordDeliveryDropped } from "./delivery-ledger.ts"
import { acquireSharedOrphanReaper } from "./orphan-reaper.ts"
import { hibernateSweepIntervalMs, hibernationEnabled, startThreadHibernator } from "./thread-hibernation.ts"
import { startUnownedBrokerAudit } from "./unowned-brokers.ts"
import { killBroker, liveBrokerRecords } from "./backend/claude-broker-host.ts"
import {
  createRetryableCleanup,
  createShutdownBarrier,
  DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
  type ShutdownBarrier,
  type ShutdownBarrierOptions,
  type ShutdownDiagnostic,
} from "./shutdown.ts"
import { log as ntwineLog } from "./logging.ts"
import { RETENTION_FIRST_SWEEP_MS, RETENTION_SWEEP_INTERVAL_MS } from "./thread-retention.ts"
import { projectScopedEnvironment } from "./project-launch.ts"
import { homedir } from "node:os"

export const CONTEXT_STARTUP_CLEANUP_TIMEOUT_MS = 4_000

// How often the server's quota heartbeat TICKS (see the heartbeat wired below). A tick is not a request:
// it reads one small cache file and only calls the usage endpoint once the reading has outlived its
// 2-minute TTL AND any `retry-after` the endpoint last answered with has passed. Ticking faster than
// either bound is what lands the refresh within 30s of the moment the endpoint allows one.
const QUOTA_REFRESH_INTERVAL_MS = 30_000

export type ContextStartupPhase =
  | "storage"
  | "interaction expiry"
  | "orphan reaper"
  | "session reconcile"
  | "subscriptions"
  | "Codex app-server bridge"
  | "Claude broker bridge"
  | "tailer"
  | "board watcher"
  | "permission producer"
  | "profile producer"
  | "wake scheduler"
  | "thread hibernation"

export interface ContextStartupFence {
  whenSafe(): Promise<void>
  recover(): Promise<void>
}

export class ContextStartupError extends Error {
  readonly startupError: unknown
  readonly cleanupError: unknown
  readonly diagnostics: readonly ShutdownDiagnostic[]
  readonly fence: ContextStartupFence

  constructor(options: {
    startupError: unknown
    cleanupError: unknown
    diagnostics: readonly ShutdownDiagnostic[]
    fence: ContextStartupFence
  }) {
    const startupMessage = options.startupError instanceof Error ? options.startupError.message : String(options.startupError)
    const cleanupMessage = options.cleanupError instanceof Error ? options.cleanupError.message : String(options.cleanupError)
    super(`Ntwine context initialization failed: ${startupMessage}; partial-context cleanup failed: ${cleanupMessage}`, {
      cause: options.startupError,
    })
    this.name = "ContextStartupError"
    this.startupError = options.startupError
    this.cleanupError = options.cleanupError
    this.diagnostics = [...options.diagnostics]
    this.fence = options.fence
  }
}

// The wired singletons every request handler shares. Built once at boot in createContext.
export interface AppContext {
  // Random per-process id minted at boot. It rides every board/board-delta SSE frame and the
  // `x-ntwine-boot` header on /rpc responses; a client that sees it CHANGE knows the server restarted
  // under a possibly-stale page and hard-reloads once. Closes the stale-bundle / zombie-reconnect class.
  bootId: string
  project: Project
  bus: Bus
  // Internal (non-wire) per-tick signal: the batch of thread slugs whose session JSONL advanced this
  // tailer tick. The /ws transcript producer subscribes to it to PUSH updated transcripts to subscribed
  // clients (replacing the client's 1.5s poll). Kept off the wire ServerEvent bus deliberately.
  transcriptChange: Emitter<string[]>
  storage: Storage
  // Durable runtime-neutral interaction journal. Default TUI backends do not publish into it; the
  // disabled-by-default app-server foundation below is the only current provider adapter.
  interactions: InteractionStore
  // Experimental foundation for NEW bridge-owned Codex sessions only. Undefined by default; it is
  // never selected by backendFor and therefore cannot migrate or control an existing TUI session.
  codexAppServer?: CodexAppServerBridge
  // The generic Agent Client Protocol bridge: any ACP agent the operator has installed, one stdio child
  // per thread (backend/acp-bridge.ts, plans/acp-backend.md). Always constructed; a dispatch fails with
  // an actionable message when the chosen agent is not installed.
  acpBridge?: AcpBridge
  // Session-broker bridge for Claude: the detached daemon that owns every claude thread's SDK session.
  // Undefined only under the NTWINE_CLAUDE_BROKER_BRIDGE="0" kill switch, which leaves claude no transport.
  claudeBroker?: ClaudeAgentBrokerBridge
  // The broker's event fold (backend/claude-runtime-ingest.ts), for readings only it has — the live
  // session cost the thread info view shows. Undefined exactly when `claudeBroker` is.
  claudeRuntimeIngest?: ClaudeRuntimeIngest
  board: BoardManager
  tailer: Tailer
  dispatcher: Dispatcher
  // Names and statuses (thread-names.ts): the dispatch mint, the AI rename, the status line, and the
  // project-wide uniqueness check every title writer runs. Optional so a hand-built test context need
  // not supply one; the router then checks uniqueness against storage alone.
  threadNamer?: ThreadNamer
  // Per-session agent-backend resolver behind the spawn/resume/transcript seam (Codex-support epic).
  // Maps a row's `backend` column (claude|codex) to its AgentBackend; DEFAULTS to claude for any unset/
  // unknown kind, so every existing session and all current behavior are unchanged until a dispatch
  // explicitly selects codex. Shared by the dispatcher, the tailer, and every resumeThread call.
  backendFor: (kind?: string) => AgentBackend
  // Durable timer scheduler (plus legacy pr/ci compatibility): resumes a rested `awaiting` session
  // on a witnessed transition. Human gates are descriptive. Started alongside the tailer; boot-safe.
  scheduler: Scheduler
  // Can the server's own `gh` read this PR? Asked by addOwnPrWatch before it arms a watcher, so a PR
  // the poll could never read is refused with the reason instead of armed in silence. Production wires
  // `probePrReadable` (one `gh pr view`); a test context injects its own answer.
  probePr: (ref: PrRef) => Promise<PrProbe>
  /** The issue twin, for the done card's Watch on a ref that is not a PR — `probeIssueReadable` (one
   *  `gh issue view`). */
  probeIssue: (ref: PrRef) => Promise<PrProbe>
  /** `ntwinectl watch-command`'s gate and runner, bound to this project (command-watch.ts). Shared with the
   *  scheduler, so registration and every later check ask the same gate. */
  commandWatches: CommandWatchService
  // Per-thread permission changes. Idle standalone TUIs are reopened on the same persisted
  // conversation with backend-native launch flags; busy/ambiguous states fail explicitly.
  // Proves an injected Claude follow-up was actually SUBMITTED, and re-presses Enter when the TUI
  // Detach storage-owned observers before board/storage teardown. Idempotent and synchronous so a
  // deferred interaction notification cannot enqueue fresh board work during the shutdown drain.
  stopSubscriptions(): void
  getSettings: () => Settings
  setSettings: (s: Settings) => Settings
  resetSettings: () => Settings
  // The prompt box's model + effort profile. Machine-level like `font` — one record for every project
  // this server serves (dispatch-preferences.ts) — which is why these close over `home` here rather
  // than the router reaching for it.
  getDispatchPreferences: (codexModels?: readonly CodexModel[]) => DispatchPreferences
  setDispatchPreference: (update: SetDispatchPreferenceInput, codexModels?: readonly CodexModel[]) => DispatchPreferences
  /**
   * Every project this PROCESS has open, with its board — the launching project and each tenant
   * activated since. Machine-wide reads (the rail's per-project queue counts) go through this rather
   * than opening databases: a count is a board fact (`needsYou` needs the tailer's runtime view), so a
   * project nobody has opened has no honest count, and this deliberately does not activate one to get
   * it. Absent under a test context or a one-project server, which read as "only this project".
   * `ctx` is that project's whole context, for a read that needs more than its board — another
   * project's thread named by handle (router `readThread` / `messageThread`).
   */
  activeTenants?: () => ReadonlyArray<{ project: Project; board: BoardManager; storage?: Storage; ctx?: AppContext }>
  /**
   * Open ONE registered project (or the Home workspace) by id and answer its context — the same activation
   * its first request would trigger. For `spawn_thread` naming a project this process has not opened
   * (router spawnTarget). Undefined for an unknown id or a project that will not open; absent under a
   * test context or a one-project server.
   */
  openProject?: (projectId: string) => Promise<AppContext | undefined>
  /**
   * The Ntwine thread that sent a cross-session message into one of THIS project's threads, for the
   * chat line that names the sender (see session-peer.ts). Absent under a test context, and then the
   * line names the sender's session without a link.
   */
  sessionPeerThread?: (peer: NonNullable<TranscriptMessage["sessionPeer"]>) => SessionPeerThread | undefined
  /**
   * Take ONE project apart while every other project keeps serving — the resource half of deleting a
   * project (router `projectRemove`). The registry half is a machine-level index file the router
   * writes itself, which is why the two are split here rather than done in one place.
   *
   * It closes that project's transports, tailer, scheduler, board and storage and drops it from the
   * tenant map. `stopWorkers` additionally kills its live worker daemons: they are DETACHED by design,
   * so closing a tenant does not touch one — right for a shutdown, wrong for a delete, where a daemon
   * left running against a state directory that is about to be unlinked writes into files nobody can
   * see and can no longer be stopped from a UI whose board is gone. `deleteState` then removes
   * `~/.ntwine/projects/<id>/`, which is everything Ntwine holds for it.
   *
   * `closed` is false when the project was not open here — which does not stop `deleteState`, since a
   * project that failed to open still has a state directory. Supplied by the server, which owns the
   * tenant map; absent under a test context or a one-project server.
   */
  teardownProject?: (
    projectId: string,
    options?: { stopWorkers?: boolean; deleteState?: boolean },
  ) => Promise<{ closed: boolean; stoppedWorkers: number }>
  /**
   * The project this server is HOSTED on — the one whose state dir and tenant it cannot let go of.
   * The project the command was typed in, or Ntwine's own stand-in folder for a launch from `$HOME`
   * or an unadopted folder (it borrowed the most recently opened project until 2026-10-11).
   *
   * Its `<stateDir>/server.lock` is the only status file this process publishes, and every worker on
   * the machine resolves the port out of it (`serverLockPathFor`, index.ts) — so removing that state
   * dir is not one card disappearing, it is every live worker losing the server. Its registry entry
   * is not held the same way: `projectRemove` forgets it and leaves the rest standing. Undefined
   * under a test context, where there is no launcher to protect.
   */
  launchProjectId?: string
  /**
   * The editor windows connected over `/_ntwine/editor` (editor-bridge.ts) — ONE bridge for the machine,
   * so a file link clicked in any project's page can land in whichever window has its folder open.
   * Supplied by the server, which owns it; absent under a test context, where every opener spawns.
   */
  editors?: EditorBridge
  /**
   * Where high-impact board actions are recorded (audit.ts): project add and remove, dispatch,
   * follow-ups and answers, each with the request origin and board session behind it. The real
   * context writes the machine's `audit.jsonl`; a test context leaves it out and records nothing.
   */
  audit?: AuditLog
  // GitHub detection (installed/inRepo/nameWithOwner) resolved ONCE at boot via initGithub() — stable
  // for the process lifetime. `authed` is NOT cached here; the githubStatus query re-checks it live so
  // a mid-session `gh auth login` reflects immediately. Undefined until initGithub() resolves (the
  // githubStatus handler falls back to a live detect during that ~30ms window). Kept OUT of the board
  // snapshot deliberately — no gh shell-out on every board delta.
  github?: GithubDetection
  // The dispatch Claude executable (tests use a stand-in). The account logout action runs the SAME
  // binary so sign-out targets the credential the workers actually use.
  claudeBin?: string
  // Same seam for Codex: the resolved app-server/backend executable, so codex logout targets
  // the binary ntwine actually runs rather than whatever "codex" is first on PATH.
  codexBin?: string
  // Thread terminals: ptys the human opened on a thread, run in the folder its agent works in, each
  // owned by this server (thread-terminals.ts) and watched over the /term transport.
  terminalRunner: TerminalRunner
  // SCHEDULED THREADS (schedules.ts, ARCHITECTURE.md § Scheduled threads). Optional so a hand-built test context
  // need not supply one; the schedule RPCs then refuse.
  schedules?: ScheduleService
  // The one-shot model call that reads a schedule out of plain words (schedule-interpreter.ts).
  scheduleInterpreter?: ScheduleInterpreter
  // Start a held thread, whoever asks — the router's send / followUp and the scheduler alike (held-start.ts). A schedule's pending next run gets its run header and its history
  // line on this path. Absent (a hand-built test context) ⇒ the router starts held rows itself.
  startHeldThread?: (row: SessionRow, prompt: string, profile?: HeldStartProfile) => Promise<{ slug: string; sessionId: string }>
  // Exact only for Ntwine's provisioned runtime. An explicit/PATH override is unknown and leaves the
  // shared Codex cache ungated; see backend/codex-models.ts.
  codexVersion?: string
}

// Read on every board build (once per scheduled row), so it is cached per Ntwine home — one process
// serves every project, and every project's context writes through the same map.
const clientZoneByHome = new Map<string, string | undefined>()

/** The machine-config record holding the zone the human's browser last reported (reportClientZone). */
export const CLIENT_ZONE_CONFIG_KEY = "clientTimeZone"

export interface ContextOptions {
  claudeBin?: string // injectable dispatch executable (tests use a stand-in)
  codexBin?: string // injectable app-server executable; unused unless the bridge flag is enabled
  codexVersion?: string // exact provisioned runtime version; undefined for an override/PATH fallback
  // startServer pins the owner-verified project before any SQLite/tailer/scheduler initialization.
  project?: Project
  /**
   * The home whose `~/.ntwine` holds the machine-level settings. Injectable so a test can point at a
   * sandbox: these were pure storage reads before machine settings existed, and a defaulted home is
   * exactly how a test run silently rewrote the maintainer's own `notifications` flag.
   */
  home?: string
  /**
   * The `server.lock` THIS PROCESS publishes — the launching project's, since that is the only one
   * written. Threaded to every tenant so a worker in a project the server did not launch from can
   * still find the port; omitted ⇒ the ntwine MCP server falls back to this project's own state dir,
   * which is right for a one-project server and is all a pre-singleton build ever passed.
   */
  serverLockPath?: string
  /**
   * The unified database every project shares (ntwine-db.ts), opened once by the server and closed by
   * it after the last tenant. Omitted ⇒ this context opens a PRIVATE file at `<stateDir>/ui.db` and
   * owns it — the shape a test wants, and one the next real boot folds in through the legacy import.
   */
  database?: Database
  /** See AppContext.activeTenants — supplied by the server, which owns the tenant map. */
  activeTenants?: AppContext["activeTenants"]
  /** See AppContext.openProject — supplied by the server, which owns the tenant map. */
  openProject?: AppContext["openProject"]
  /** See AppContext.teardownProject — supplied by the server, which owns the tenant map. */
  teardownProject?: AppContext["teardownProject"]
  /** See AppContext.launchProjectId — supplied by the server, which knows which project launched it. */
  launchProjectId?: string
  /** See AppContext.editors — supplied by the server, which owns the one bridge. */
  editors?: EditorBridge
  /** Internal deterministic construction/rollback seam. */
  startup?: {
    afterPhase?: (phase: ContextStartupPhase) => void
    cleanupTimeoutMs?: number
    cleanupDiagnostic?: (event: ShutdownDiagnostic) => void
    cleanupDeadline?: ShutdownBarrierOptions["deadline"]
  }
}

// Boot reconcile: a session row whose worker is no longer live was orphaned by a prior server exit
// (or the agent finished/was killed) — stamp exited so the registry doesn't show a forever-running
// ghost. Runtime is also derived live on each board build; this keeps the stored column honest too.
//
// It spawns nothing and asks the OS nothing, because both answers below are decidable from the row
// itself. It used to probe a live inventory of the machine's worker terminals — one subprocess per
// row, run synchronously, before the server could listen: 165 rows measured 5.2-6.3s of pure
// process-spawn on the maintainer's board and grew linearly with thread count, the larger half of the
// "context" boot phase. Batching that inventory into one ≤900ms-old snapshot removed the cost; the
// transport cutover removed the question.
export function reconcileSessions(storage: Storage) {
  for (const row of storage.allSessions()) {
    // A headless thread (codex app-server OR broker Claude) has NO process of ntwine's own to look at by
    // construction — it lives in a detached daemon that OUTLIVES ntwine. Reading its absence from this
    // process as death would stamp `exited` on every healthy headless thread at every boot — the exact
    // trap deriveRuntime() in board.ts refuses to fall into, and for the broker it would destroy the
    // whole ownerless-reconnect premise. Its liveness is resolved live on each board build (the bridge's
    // turn state / the daemon record); leave the stored column alone.
    if (isHeadlessRow(row)) continue
    // A non-headless row is PRE-CUTOVER: its transport was an interactive terminal session, and ntwine
    // has not launched one since, so it cannot be alive. Mark it exited once at boot rather than
    // probing for a runtime that cannot exist.
    if (row.exited !== 1) {
      storage.setExitedIfCurrent(row.slug, row.session_id, row.runtime_generation ?? 0, true)
    }
  }
}

// Resolve the stable GitHub detection triple once and cache it on ctx.github. Never throws
// (detectGithub swallows every gh failure), so it is safe to fire-and-forget at boot: a broken or
// absent gh just leaves the feature off. Called from startServer without blocking the listen — the
// githubStatus handler live-detects during the brief pre-cache window.
export async function initGithub(ctx: AppContext): Promise<void> {
  // The Home workspace has no repository, not even when the home folder is a checkout (router.ts
  // resolveRepo says why). Leaving ctx.github unset is what every surface already reads as "not a repo".
  if (isHomeWorkspace(ctx.project.id)) return
  ctx.github = await detectGithub(ctx.project.dir)
}

interface PartialContextResources {
  storage?: Storage
  stopSubscriptions?: () => void
  codexAppServer?: CodexAppServerBridge
  acpBridge?: AcpBridge
  claudeBroker?: ClaudeAgentBrokerBridge
  claudeRuntimeIngest?: ClaudeRuntimeIngest
  board?: BoardManager
  tailer?: Tailer
  scheduler?: Scheduler
}

interface PartialContextCleanup {
  tailer(): Promise<void>
  subscriptions(): Promise<void>
  scheduler(): Promise<void>
  board(): Promise<void>
  codexAppServer(): Promise<void>
  acpBridge(): Promise<void>
  claudeBroker(): Promise<void>
  storage(): Promise<void>
}

function partialContextCleanup(resources: PartialContextResources): PartialContextCleanup {
  return {
    tailer: createRetryableCleanup(() => resources.tailer?.stop()),
    subscriptions: createRetryableCleanup(() => resources.stopSubscriptions?.()),
    scheduler: createRetryableCleanup(async () => { await resources.scheduler?.stop() }),
    board: createRetryableCleanup(async () => { await resources.board?.stop() }),
    codexAppServer: createRetryableCleanup(async () => { await resources.codexAppServer?.shutdown() }),
    acpBridge: createRetryableCleanup(async () => { await resources.acpBridge?.shutdown() }),
    claudeBroker: createRetryableCleanup(async () => { resources.claudeBroker?.close(); resources.claudeRuntimeIngest?.close() }),
    storage: createRetryableCleanup(() => resources.storage?.close()),
  }
}

function contextCleanupBarrier(
  cleanup: PartialContextCleanup,
  opts: ContextOptions,
  diagnostic: (event: ShutdownDiagnostic) => void,
): ShutdownBarrier {
  return createShutdownBarrier({
    timeoutMs: opts.startup?.cleanupTimeoutMs ?? CONTEXT_STARTUP_CLEANUP_TIMEOUT_MS,
    // Bound + name each producer so a wedged one cannot stall startup-rollback cleanup indefinitely.
    phaseTimeoutMs: DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
    diagnostic,
    deadline: opts.startup?.cleanupDeadline,
    phases: [
      { name: "context tailer", run: cleanup.tailer },
      { name: "context subscriptions", run: cleanup.subscriptions },
      { name: "context wake scheduler", run: cleanup.scheduler },
      { name: "context board watcher", run: cleanup.board },
      {
        name: "context Codex app-server bridge",
        run: cleanup.codexAppServer,
      },
      {
        name: "context Claude broker bridge",
        run: cleanup.claudeBroker,
      },
    ],
    closeStorage: cleanup.storage,
  })
}

/**
 * Deliver a scheduler wake to a CODEX thread over the app-server bridge — adopting a legacy TUI-era
 * rollout first, then reactivating the persisted thread — exactly like the followUp RPC.
 *
 * Extracted from the scheduler `resume` closure so the promise contract below is directly testable.
 * It MUST return the promise rather than detaching it: the scheduler AWAITS `resume` and owns the
 * retry/supersede policy on rejection (scheduler.ts `deliverDue`). It previously ran this work in a
 * `void (async () => …)().catch(() => {})` IIFE and returned `undefined` synchronously, so the
 * scheduler saw an instant success and ACKED the delivery, while the real bridge failure landed
 * seconds later into a bare catch and vanished — no log, no retry, the wake lost permanently.
 * Claude's synchronous `resumeThread` throws straight into that same catch and retries correctly, so
 * the defect was CODEX-ONLY and silent: an `awaiting timer:` or limit-auto-resume codex thread could
 * simply never wake. See context.codex-wake.test.ts.
 */
export function deliverCodexWake(deps: {
  bridge: Pick<CodexAppServerBridge, "adoptExternalRollout" | "binding" | "resumeOwnedSession" | "followUp">
  storage: Pick<Storage, "setCodexRuntime">
  cwd: string
  row: { session_id: string; agent_session_id?: string | null; codex_runtime?: string | null }
  slug: string
  deliveryMessage: string
  deliveryId: string
}): Promise<void> {
  const { bridge, storage, cwd, row, slug, deliveryMessage, deliveryId } = deps
  return (async () => {
    if (row.codex_runtime !== "app-server" && row.agent_session_id) {
      await bridge.adoptExternalRollout({ threadSlug: slug, sessionId: row.session_id, codexThreadId: row.agent_session_id, cwd })
      storage.setCodexRuntime(slug, "app-server")
    }
    const binding = bridge.binding(slug, row.session_id)
    if (!binding || binding.state !== "active") await bridge.resumeOwnedSession(slug, row.session_id)
    await bridge.followUp({ threadSlug: slug, sessionId: row.session_id, text: deliveryMessage, deliveryId })
  })()
}

/**
 * A scheduled wake (awaiting-timer, limit-auto-resume) for a broker-backed Claude thread. The broker
 * has no local process to inject into, so the legacy `resumeThread` path would misfire (it throws
 * outright now); route through the bridge, which reconnects the live daemon's socket or cold-resumes a
 * dead one. Returns the promise so the scheduler owns the retry/supersede policy (see
 * deliverCodexWake for why detaching it loses the wake silently).
 * The worker system prompt is rebuilt so a cold resume re-applies it (ignored when the daemon is live).
 */
export function deliverClaudeBrokerWake(deps: {
  bridge: Pick<ClaudeAgentBrokerBridge, "followUp">
  slug: string
  cwd: string
  /**
   * Where the board lives when it is not `cwd` — the Home workspace (home-workspace.ts), whose NTWINE.md
   * and scratch directories are in its state directory while its agents run in the home folder.
   */
  boardDir?: string
  row: { session_id: string; model?: string | null; effort?: string | null; permission_mode?: string | null } & Parameters<typeof deadlineSection>[0]
  /** The operator's Settings, for the floor a row with NO persisted mode cold-resumes at (coldResumePermission). */
  settings: Pick<Settings, "permissionMode">
  deliveryMessage: string
  /** Retire the live daemon first — see the bridge's followUp contract and needsFreshProcessForLimit. */
  freshProcess?: boolean
  /** What the worker can reach if this wake cold-resumes it (dispatch.ts workerCapabilities). */
  capabilities?: WorkerCapabilities
}): Promise<void> {
  const { bridge, slug, cwd, row, settings, deliveryMessage, freshProcess } = deps
  const board = { dir: deps.boardDir ?? cwd, workDir: cwd }
  const appendSystemPrompt = [
    loadWorkerPrompt("claude", deps.capabilities),
    scratchpadOrientation(row.session_id, "claude", workerScratchPath(board, row.session_id)),
    ntwineConfigBlock(board.dir),
    deadlineSection(row),
  ].filter(Boolean).join("\n\n")
  return bridge.followUp({
    threadSlug: slug,
    sessionId: row.session_id,
    cwd,
    text: deliveryMessage,
    permissionMode: coldResumePermission(row, settings),
    appendSystemPrompt,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    freshProcess,
    // A wake is not the operator answering: an approval or question card open on this thread stays open,
    // and the wake is read once they have answered it. Without this a timer coming due, a schedule beat
    // or a report held past the mid-turn ceiling DENIED the open approval on the operator's behalf.
    keepOpenCards: true,
  })
}

/**
 * Context construction is atomic to startServer: if any constructor/reconciliation step throws,
 * every already-created timer, observer, bridge, watcher and storage handle drains behind the same
 * bounded lifecycle barrier before the error crosses the ownership boundary.
 */
/**
 * The per-PROJECT half of a shutdown, named so a caller can order it against its own phases.
 *
 * Process-level transports — the HTTP server, the app socket, Vite — belong to
 * the server, not to any one project, and stay with startServer. Everything here belongs to a single
 * AppContext, which is what makes it reusable: today startServer runs these once at exit, and a
 * tenant lifecycle runs the same set when one project is deactivated while others keep serving.
 *
 * Every entry tolerates a MISSING context on purpose. Each shutdown phase is requiredForStorage by
 * default, so a TypeError here would not merely log — it would fail the whole barrier with "could not
 * safely close storage", turning a recoverable startup failure into a wedged one.
 */
export function projectContextCleanups(get: () => AppContext | undefined): {
  tailer: () => void
  terminalRunner: () => void
  subscriptions: () => void
  scheduler: () => Promise<void>
  board: () => Promise<void>
  bridge: () => Promise<void>
  storage: () => void
} {
  return {
    tailer: () => get()?.tailer.stop(),
    // Hang up every thread terminal's process group; a dev server must not outlive its project.
    terminalRunner: () => get()?.terminalRunner?.shutdown(),
    subscriptions: () => get()?.stopSubscriptions(),
    scheduler: async () => { await get()?.scheduler.stop() },
    board: async () => { await get()?.board.stop() },
    bridge: async () => { await get()?.codexAppServer?.shutdown() },
    storage: () => get()?.storage.close(),
  }
}

export async function createContext(opts: ContextOptions = {}): Promise<AppContext> {
  const resources: PartialContextResources = {}
  const cleanup = partialContextCleanup(resources)
  try {
    return createContextUnchecked(opts, resources)
  } catch (startupError) {
    const diagnostics: ShutdownDiagnostic[] = []
    const diagnostic = (event: ShutdownDiagnostic) => {
      diagnostics.push(event)
      opts.startup?.cleanupDiagnostic?.(event)
    }
    let barrier = contextCleanupBarrier(cleanup, opts, diagnostic)
    let activeSafety = barrier.whenDrained()
    void activeSafety.catch(() => undefined)
    let cleanupError: unknown
    try {
      await barrier.close()
      await activeSafety
    } catch (error) {
      cleanupError = error
    }
    if (!cleanupError) throw startupError

    let recovery: Promise<void> | null = null
    const fence: ContextStartupFence = {
      whenSafe: () => activeSafety,
      recover: () => {
        if (recovery) return recovery
        barrier = contextCleanupBarrier(cleanup, opts, diagnostic)
        activeSafety = barrier.whenDrained()
        void activeSafety.catch(() => undefined)
        const attempt = barrier.close().then(() => activeSafety)
        recovery = attempt
        void attempt.catch(() => {
          if (recovery === attempt) recovery = null
        })
        return attempt
      },
    }
    throw new ContextStartupError({ startupError, cleanupError, diagnostics, fence })
  }
}

function createContextUnchecked(opts: ContextOptions, resources: PartialContextResources): AppContext {
  const home = opts.home ?? homedir()
  const project = opts.project ?? resolveProject()
  // Per-PROJECT isolation (C3): two ntwine instances must never see each other's workers. Everything
  // that could collide now keys on the resolved project's own state dir — this registry DB, the broker
  // daemon's record under `<stateDir>/claude-broker/` and the socket path hashed from it, the
  // app-server record — so isolation follows from resolving the project and there is no separate
  // per-instance runtime identity to derive. (There was one: workers ran under a shared multiplexer
  // server keyed by socket name, whose sessions were all called `ntwine-<slug>`, so the socket had to be
  // derived from the stable project id before anything touched it, and a disposable child that re-read
  // it from the environment could move live workers onto another server mid-run.) The launcher/project
  // resolver still performs the crash-safe legacy migration exactly once and pins the result through
  // supervisor/child/reexec ownership.
  const storage = createStorage(opts.database ?? join(project.stateDir, "ui.db"), project.id)
  resources.storage = storage
  // A secret is served from memory through a named pipe (secret-files.ts), so any pipe a previous
  // process left has no writer behind it and would hang its reader: clear them before anything can ask.
  clearSecrets(project.stateDir)
  const bus = new Bus()
  const transcriptChange = new Emitter<string[]>()
  const bootId = randomUUID()
  // Late-bound for the journal observer and tailer callbacks; boot expiry runs before assignment and
  // needs no board edge because the first build reads authoritative pending state directly.
  let board!: BoardManager
  // The same late binding for the tailer's half of that observer: boot expiry answers nothing a tailer
  // that has not primed yet could be holding a permission block for.
  let permissionAnswered: ((slug: string) => void) | undefined
  const contextUnsubscribers: (() => void)[] = []
  let subscriptionsStopped = false
  const stopSubscriptions = () => {
    if (subscriptionsStopped) return
    const failures: { unsubscribe: () => void; error: unknown }[] = []
    for (const unsubscribe of contextUnsubscribers.splice(0).reverse()) {
      try {
        unsubscribe()
      } catch (error) {
        failures.push({ unsubscribe, error })
      }
    }
    if (failures.length > 0) {
      // Preserve failed observers for an explicit recover() attempt while still trying every sibling.
      contextUnsubscribers.push(...failures.map(({ unsubscribe }) => unsubscribe).reverse())
      throw new AggregateError(
        failures.map(({ error }) => error),
        `could not detach ${failures.length} context subscription${failures.length === 1 ? "" : "s"}`,
      )
    }
    subscriptionsStopped = true
  }
  resources.stopSubscriptions = stopSubscriptions
  opts.startup?.afterPhase?.("storage")

  contextUnsubscribers.push(storage.interactions.subscribe((change) => {
    // The DB is project-local, but still verify the explicit protocol owner before publishing. A
    // malformed/future adapter can never leak another project's invalidation onto this server.
    if (change.projectId !== project.id) return
    bus.publish({
      type: "interactions-invalidated",
      slug: change.threadSlug,
      sessionId: change.sessionId,
      interactionId: change.interactionId,
      lifecycle: change.lifecycle,
      recordRevision: change.recordRevision,
    })
    // BEFORE the board hears it: the refresh below must not pair "nothing pending" with a permission
    // block the tailer has not re-read yet (see Tailer.permissionAnswered).
    if (change.lifecycle !== "pending") permissionAnswered?.(change.threadSlug)
    board?.interactionChanged?.(change)
  }))
  storage.interactions.expireDue()
  opts.startup?.afterPhase?.("interaction expiry")

  // Keep the shared Claude quota cache warm (as often as the endpoint allows), independent of any browser
  // poll, so the sidebar chip (and the scheduler's weekly-reset check) always reads a recent value
  // rather than the multi-minute-stale reading a purely read-driven cache served during a fast
  // fleet burn. One cheap endpoint GET, on the same non-blocking background path a stale read kicks;
  // the cross-process lock and the persisted `retryAt` keep N Ntwine processes to one request per window. Gated on the
  // same NTWINE_WAKERS_OFF flag as the scheduler so a disposable adhoc/test stack never touches the real
  // account with the real credential.
  if (process.env.NTWINE_WAKERS_OFF !== "1") {
    void refreshClaudeQuotaInBackground(opts.claudeBin) // warm immediately so the first read is fresh
    const quotaRefreshTimer = setInterval(() => {
      void refreshClaudeQuotaInBackground(opts.claudeBin)
    }, QUOTA_REFRESH_INTERVAL_MS)
    quotaRefreshTimer.unref?.()
    contextUnsubscribers.push(() => clearInterval(quotaRefreshTimer))
  }

  // Reap this machine's leaked worker aux — verification browsers (agent-browser/chrome-devtools/
  // puppeteer) and MCP/dev servers that daemonized out of a stopped worker's process tree, so nothing
  // else ever collects them. A sweep on startup clears accumulated leaks; the interval catches new
  // orphans (a stopped/crashed thread's browsers) within a bounded window. Reaps ONLY processes whose
  // NTWINE_THREAD slug has no live claude/codex root; never a session root, never ntwine itself, and
  // never a leftover multiplexer server from a pre-cutover ntwine (orphan-reaper.ts keeps that one
  // guard deliberately — an operator may still be reading those panes).
  // NTWINE_ORPHAN_REAPER_OFF disables it for disposable adhoc/test stacks (mirrors NTWINE_WAKERS_OFF) so a
  // throwaway instance never reaps the real machine's processes. The sweep is machine-wide, so every
  // project's context shares the server's ONE reaper rather than starting its own.
  if (!process.env.NTWINE_ORPHAN_REAPER_OFF) {
    contextUnsubscribers.push(acquireSharedOrphanReaper({ log: (m) => ntwineLog.info("reaper", m) }))
  }
  opts.startup?.afterPhase?.("orphan reaper")
  reconcileSessions(storage)
  opts.startup?.afterPhase?.("session reconcile")
  opts.startup?.afterPhase?.("subscriptions")

  // The agent backends behind the spawn/resume/transcript seam (Codex-support epic). The ClaudeBackend's
  // transcript dir matches the tailer's (defaultLogDir) so foreign-scan + per-session path stay
  // consistent; the CodexBackend uses $CODEX_HOME (default ~/.codex). `backendFor` maps a row's `backend`
  // column to the right one, DEFAULTING to claude for any unset/unknown kind — so a session is codex ONLY
  // when it was dispatched codex, and every claude path is byte-identical to before.
  // Where a worker of THIS project reaches the server, and whose board its ntwine tools act on. One
  // process serves N projects but publishes ONE `server.lock` (the launcher's), and an unprefixed
  // `/_ntwine/rpc/…` is the launching project by definition — so a tenant's workers need both halves
  // spelled out or their tools either cannot find the port at all or act on the wrong board.
  const ntwineMcpTarget: NtwineMcpTarget = {
    stateDir: project.stateDir,
    ...(opts.serverLockPath ? { serverLock: opts.serverLockPath } : {}),
    projectId: project.id,
  }
  const claudeBackend = createClaudeBackend({ logDir: defaultLogDir(project), claudeBin: opts.claudeBin })
  const codexBackend = createCodexBackend({})
  const acpBackend = createAcpBackend({ stateDir: project.stateDir })
  const backendFor = (kind?: string): AgentBackend => (kind === "codex" ? codexBackend : kind === "acp" ? acpBackend : claudeBackend)
  const codexAppServer = codexAppServerBridgeEnabled()
    ? createCodexAppServerBridge({
        projectId: project.id,
        // The cwd of every codex thread and of the daemon: where this project's agents run.
        projectDir: workDirOf(project),
        // The detached app-server daemon's socket + record live under the project state dir, so a
        // later ntwine generation can find the app-server this one left running.
        stateDir: project.stateDir,
        // Codex's MCP servers mount PROCESS-wide on the app-server, not per thread, so the descriptor
        // is resolved once here — the codex twin of the per-dispatch resolveNtwineMcp on the claude side.
        ntwineMcp: resolveNtwineMcp(ntwineMcpTarget),
        // …and only for a thread whose contract taught it the MCP tools: a codex thread keeps the
        // contract it was started with, so one that predates `ntwinectl` keeps its mount.
        mountsMcp: (slug) => workerTaughtMcp(storage.getSession(slug)),
        ntwineCli: resolveNtwineCli(ntwineMcpTarget),
        // The rest of a worker thread's config — hooks and reasoning summaries — sent with the start
        // and every resume, so a thread that comes back under this server runs on this server's.
        // A Home thread runs outside its board, so its scratchpad hook is told where the board is.
        workerConfig: (_slug, sessionId) => codexWorkerThreadConfig(sessionId, workDirOf(project) !== project.dir ? project.dir : undefined),
        db: storage.db,
        interactions: storage.interactions,
        codexBin: opts.codexBin,
        // Persist the bridge's lifecycle events so a mid-turn daemon death is diagnosable after the
        // fact. Before this the diagnostic sink was unset and every death — the six-sub-agent loss
        // included — was an unattributable "the thread went quiet." See codex-app-server-diagnostics.ts.
        diagnostic: createCodexDiagnosticSink(project.stateDir, project.id),
        onStatusChange: () => board?.refresh(),
        // Never wake a thread the human has already put away: a restart-recovery nudge is only for a
        // thread that is still open and still theirs to come back to.
        shouldAutoResume: (slug) => {
          const row = storage.getSession(slug)
          return Boolean(row) && row?.state !== "archived" && row?.archived !== 1
        },
        // The operator's sandbox intent, so a COLD `thread/resume` carries it. ntwine's registry is the
        // single authority here — `setThreadPermission` persists `permission_mode` on every change,
        // including the ones the eager apply could not deliver — which is what finally makes the
        // "saved for the next resume" copy true. Scoped by session id so a stale binding for a
        // replaced session can never pull a newer row's permission.
        sandboxFor: (slug, sessionId) => {
          const row = storage.getSession(slug)
          if (!row || row.backend !== "codex" || row.session_id !== sessionId) return undefined
          const mode = PermissionMode.safeParse(row.permission_mode)
          // No recorded intent (a row from before permission_mode was stamped) ⇒ send no override at
          // all, so the resume behaves exactly as it did before this existed.
          if (!mode.success) return undefined
          return codexSandbox(mode.data) as CodexSandboxMode
        },
        // Read at every thread/start and cold resume, so the Codex context window the operator picks in
        // Settings reaches the next thread without an app-server restart.
        getSettings: () => getSettings(storage, home),
      })
    : undefined
  resources.codexAppServer = codexAppServer
  if (codexAppServer) {
    contextUnsubscribers.push(storage.subscribeSessionLifecycle((event) => {
      codexAppServer.releaseSession(
        event.previous.slug,
        event.previous.session_id,
        event.type === "replaced" ? "session-replaced" : "session-deleted",
      )
    }))
  }
  // Rejoin the detached app-server daemon now rather than on first use. A turn that outlived our
  // restart is still running in there, and until we attach its `turn/completed` sits queued and the
  // board's stall grace would card the thread as crashed. Fire-and-forget: codex being unavailable
  // must never hold up (or fail) a boot.
  void codexAppServer?.warmUp()
  opts.startup?.afterPhase?.("Codex app-server bridge")

  // The generic ACP bridge. Its agents live in detached daemons (acp-host.ts), so like codex and the
  // Claude broker it warms up: every open thread whose daemon survived the restart is reattached now,
  // in-flight turn adopted, rather than on its next input.
  const acpBridge = createAcpBridge({
    projectId: project.id,
    stateDir: project.stateDir,
    ntwineMcp: resolveNtwineMcp(ntwineMcpTarget),
    mountsMcp: (slug) => workerTaughtMcp(storage.getSession(slug)),
    ntwineCli: resolveNtwineCli(ntwineMcpTarget),
    interactions: storage.interactions,
    env: process.env,
    customAgents: () => getSettings(storage, home).acpAgents,
    onStatusChange: () => board?.refresh(),
  })
  resources.acpBridge = acpBridge
  contextUnsubscribers.push(storage.subscribeSessionLifecycle((event) => {
    acpBridge.releaseSession(event.previous.slug, event.previous.session_id, event.type === "replaced" ? "session-replaced" : "session-deleted")
  }))
  // Same predicate as the Claude broker's boot reattach: open, unarchived ACP rows only. Fire-and-forget:
  // one agent that cannot be reached must never hold up (or fail) a boot.
  void acpBridge.warmUp(
    storage.allSessions()
      .filter((row) => row.backend === "acp" && row.state !== "archived" && row.archived !== 1)
      .map((row) => ({ threadSlug: row.slug, sessionId: row.session_id, cwd: workDirOf(project), agentId: row.acp_agent ?? "", modelId: acpModelIdFromModel(row.model), effort: row.effort, acpSessionId: row.agent_session_id })),
  )

  // The consumer for the broker's structured event stream. Until this existed the bridge forwarded
  // every SDK event to a `deps.onEvent` nobody supplied, so the whole stream was dropped and the
  // tailer re-derived the same state by polling the SDK's JSONL off disk on a 1–10s tick. The ingest
  // does not replace that fold — it nudges it (re-read NOW, not on the next tick) and supplies the
  // provider's own turn reading, which the fold may consult but never be overridden by. See
  // backend/claude-runtime-ingest.ts. Created BEFORE the bridge because the bridge takes its handler;
  // its nudge target is the tailer, created below, so `tailer` is late-bound the same way `board` is.
  const claudeRuntimeIngest = claudeBrokerBridgeEnabled() ? createClaudeRuntimeIngest({ nudge: () => tailer.nudge?.() }) : undefined
  resources.claudeRuntimeIngest = claudeRuntimeIngest

  // Claude session-broker bridge — the detached daemon that owns every claude thread's SDK session,
  // and the only claude transport. NTWINE_CLAUDE_BROKER_BRIDGE="0" turns it off, which leaves a claude
  // dispatch with nothing to run on rather than a second path. Permissions auto-allow for
  // now (matching today's `--permission-mode auto`); dashboard approval routing is the next slice.
  const claudeBroker = claudeBrokerBridgeEnabled()
    ? createClaudeAgentBrokerBridge({
        onEvent: (slug, sessionId, event) => claudeRuntimeIngest?.onEvent(slug, sessionId, event),
        // The ceiling this thread's daemon actually runs under, which is what the header's context reading
        // has to divide by: a `[1m]` worker forked at the shipped 500K compacts at 500K, and reading its
        // fullness against 1M reported a comfortable 25% for a session that was half full.
        onCompactionWindow: (sessionId, window) => claudeRuntimeIngest?.noteCompactionWindow(sessionId, window),
        stateDir: project.stateDir,
        executablePath: opts.claudeBin ?? "claude",
        // Scoped to THIS project, not to whichever one launched the server — see
        // projectScopedEnvironment. A raw process.env spread is how project A identity would reach
        // project B agent once one process holds both.
        env: projectScopedEnvironment(process.env, {
          projectId: project.id,
          projectDir: project.dir,
          stateDir: project.stateDir,
          ...(project.identityScope ? { identityScope: project.identityScope } : {}),
        }),
        // Route Claude tool-permission escalations to the dashboard approval UI (provider-neutral
        // InteractionStore; the same store + web cards codex approvals use).
        interactions: storage.interactions,
        projectId: project.id,
        // The ntwine worker environment — the SDK equivalent of the CLI argv's --plugin-dir / --mcp-config.
        // Computed ONCE here (constant per project) and applied on every broker fork so a broker worker
        // gets the ntwine sub-agent profiles, the ntwine MCP server (the only one ntwine mounts), and the
        // cc-worker hooks. The project's own `.mcp.json` servers are merged in by the broker daemon at each
        // fork (project-mcp-servers.ts): under `--strict-mcp-config` nothing mounts that ntwine did not hand over.
        workerEnv: {
          pluginDir: workerPluginDir(),
          ...claudeCliConfig(resolveNtwineCli(ntwineMcpTarget)),
          permDir: permRequestDir(project),
          // Only where the board is NOT the worker's cwd (the Home workspace): the cc-worker hooks write
          // the scratch directory and session state under it instead of under their cwd.
          ...(workDirOf(project) !== project.dir ? { boardRoot: project.dir } : {}),
          cli: resolveNtwineCli(ntwineMcpTarget),
        },
        // Read at every fork, not captured once: the compaction window is a Settings value the drawer
        // can change while the server runs, and the next dispatch or cold resume should carry it.
        getSettings: () => getSettings(storage, home),
        mcpGrants: (slug) => threadMcpGrants(storage.listThreadQuestions(slug)),
        mcpOnRequest: (cwd, grants) => mcpOnRequestSection(cwd, grants),
        // Which broker threads warmUp() may reattach at boot. Same predicate codex's shouldAutoResume
        // applies: never wake a thread the human has already put away — a boot reattach is only for a
        // thread that is still open and still theirs to come back to. Broker-backed rows only; a
        // pre-cutover claude row has no daemon and a codex row is the other bridge's business.
        ownedSessions: () =>
          storage.allSessions()
            .filter((row) => isBrokerClaudeRow(row) && row.state !== "archived" && row.archived !== 1)
            .map((row) => ({ threadSlug: row.slug, sessionId: row.session_id, cwd: workDirOf(project) })),
        // The server log is the right surface for the two diagnostics worth a line — a daemon that died
        // (invisible to the live relay, so the bridge synthesizes it from the dead daemon's own exit
        // record) and an input the daemon threw away. It is what an operator, and the next agent
        // debugging a lost thread, already greps when a thread goes quiet. Which diagnostics qualify and
        // how they read is describeClaudeBrokerDiagnostic's business, so it stays testable on its own.
        onDiagnostic: (slug, _sessionId, diagnostic) => {
          const line = describeClaudeBrokerDiagnostic(diagnostic)
          if (line) ntwineLog.warn("broker", `claude broker ${slug}: ${line}`)
          // A LOG LINE IS NOT ENOUGH, and this is where that was learned twice. The line above turned a
          // silent afternoon into one grep; it still left the operator staring at eight gray bubbles with
          // no way to move them. `ageDeliveries` holds an `enqueued` row for a full hour on the premise
          // that "an enqueue record is positive evidence Claude Code holds the message in its own queue"
          // — true of every other enqueue, and precisely false of a REFUSED one, which no one holds.
          //
          // So retire the row the instant the daemon says it threw the message away. Clicking the bubble
          // could not do it: unqueue asks the CURRENT daemon to cancel the id, and the daemon that
          // refused it is by then dead, so the answer is `false` and the operator gets "Too late — that
          // message has already left the queue", which is exactly backwards (maintainer 2026-08-05: "If
          // they've been dequeued and swallowed, then they shouldn't be showing up in the fucking UI").
          //
          // …and retiring it must not make the message VANISH, which is what this did until 2026-10-01: it
          // tombstoned the row (`cancelled`), the state for an operator's deliberate unqueue, which keeps the
          // text in the row and renders nothing. The operator's words simply disappeared from the thread.
          // A drop is a send the operator still wants and the agent never got — `failed`, with the text on
          // screen and Retry / Edit / Dismiss under it, exactly like a send whose transport threw. The
          // `dropped` mark keeps a later JSONL record with the same words from re-queueing it (see
          // recordDeliveryDropped). Push the transcript frame too: the ledger is not JSONL bytes, so no
          // tailer tick would carry this change to an open tab.
          const dropped = droppedDeliveryId(diagnostic)
          if (dropped && recordDeliveryDropped(storage, slug, dropped, droppedDeliveryReason(diagnostic))) {
            ntwineLog.warn("broker", `claude broker ${slug}: follow-up ${dropped} was dropped by the daemon and is kept for the operator`)
            transcriptChange.emit([slug])
            resources.board?.refresh()
          }
        },
      })
    : undefined
  resources.claudeBroker = claudeBroker
  if (claudeBroker) {
    contextUnsubscribers.push(storage.subscribeSessionLifecycle((event) => {
      claudeBroker.releaseSession(
        event.previous.slug,
        event.previous.session_id,
        event.type === "replaced" ? "session-replaced" : "session-deleted",
      )
      // Drop the runtime turn reading with the session it described. A replaced session reuses the
      // slug, so a stale "running" left behind here would be consulted for the NEW session's row.
      claudeRuntimeIngest?.release(event.previous.session_id)
    }))
  }
  // Rejoin every broker daemon this project left running, now rather than on the next dispatch or
  // follow-up. The broker adopted purely lazily, so after a restart a turn still running inside a
  // detached daemon had nobody observing it: its queued events went unread (no ingest reading, no
  // tailer nudge), and — the real bug — a tool-permission escalation raised while ntwine was down stayed
  // held in the daemon, so no approval card appeared and the thread read as hung until a human poked
  // it. The daemon re-delivers those pending requests on reconnect; this is what reconnects.
  // Fire-and-forget, exactly like codex's above: a broker being unavailable must never fail or delay a
  // boot.
  void claudeBroker?.warmUp()
  // …and say which daemons it did NOT rejoin. A daemon no open row claims is rejoined by nobody — the
  // hibernator skips row-less daemons and the orphan reaper never touches a session root — so it would
  // otherwise sit unlisted until its own six-hour idle timer. This lists each one now, re-checks on the
  // hibernation sweep's cadence, and ends only the kind that provably never held a conversation
  // (unowned-brokers.ts).
  if (claudeBroker) {
    contextUnsubscribers.push(startUnownedBrokerAudit({
      liveDaemons: () => liveBrokerRecords(project.stateDir),
      rows: () => storage.allSessions(),
      end: (sessionId) => killBroker(project.stateDir, sessionId, "unowned-never-prompted"),
      log: (m) => ntwineLog.warn("broker", m),
      intervalMs: hibernateSweepIntervalMs(),
    }))
  }
  opts.startup?.afterPhase?.("Claude broker bridge")

  // The tailer derives turn/liveness telemetry and, on a state change, asks the board for an
  // OVERLAY-ONLY refresh (tailer changes never alter .ntwine content — the full shell-out rebuild
  // here was the source of multi-second RPC stalls). Late-bound `board` breaks the cycle.
  // It ALSO reports, per tick, which sessions' JSONL advanced → fanned out on transcriptChange so the
  // /ws transcript producer can push (no board dependency; the two signals are independent).
  // Every model call Ntwine makes on its own — the namer, both status writers, the effort chooser and the
  // schedule reader below — is on unless its NTWINE_*=0 variable switches it off, and each module falls
  // back as it always did with no model wired.
  const model = (complete: ClaudeOneShot, off: boolean): (() => ClaudeOneShot | undefined) => () => off ? undefined : complete
  const namerOff = process.env.NTWINE_THREAD_NAMER === "0"
  // THE THREAD NAMER (thread-names.ts): mints a 1-2 word, project-unique NAME at dispatch, answers the AI
  // rename, and writes the live STATUS line — all through one short Claude completion with Ntwine's own
  // prompt (backend/claude-oneshot.ts). It spawns nothing on its own: every call is a dispatch, a click or
  // a thread's 5th message. With NTWINE_THREAD_NAMER=0 it has no model;
  // uniqueness still holds for every writer without it, because that check reads the registry, not a model.
  const namerModel = model(createClaudeOneShot({ claudeBin: opts.claudeBin, cwd: workDirOf(project) }), namerOff)
  const threadNamer: ThreadNamer = createThreadNamer({
    storage,
    elsewhere: () => openThreadsElsewhere(opts.activeTenants?.() ?? [], project.id),
    get complete() { return namerModel() },
    onNamed: () => board.refresh(),
    log: (message) => ntwineLog.warn("server", `thread namer: ${message}`),
  })
  // At every rest the conversation moved, write the thread's live STATUS from the recent conversation —
  // never its name (periodic-status.ts).
  const periodicStatus = createPeriodicStatus({
    storage,
    // A getter, like every completer here.
    get writeStatus() { return threadNamer.available ? (input: { name?: string; conversation: string }) => threadNamer.status(input) : undefined },
    nameOf: (row) => threadNamer.threads().find((t) => t.slug === row.slug)?.name || undefined,
    readMessages: (sessionId, forkAnchor) => readTranscriptYielding(project, sessionId, forkAnchor),
    onStatus: () => board.refresh(),
    onError: (slug, error) => process.stderr.write(`[ntwine] status of ${slug} failed: ${error instanceof Error ? error.message : String(error)}\n`),
  })
  // While a turn runs, keep the status on the TASK the thread is working on, with its own clock
  // (live-status.ts). Its own completer, so a dispatch's name mint never queues behind a fleet's checks.
  // Off with NTWINE_LIVE_STATUS=0 or NTWINE_THREAD_NAMER=0;
  // NTWINE_LIVE_STATUS_MS shortens the cadence for a verification run.
  const liveStatusMs = Number(process.env.NTWINE_LIVE_STATUS_MS)
  const liveStatusModel = model(createClaudeOneShot({ claudeBin: opts.claudeBin, cwd: workDirOf(project) }), namerOff || process.env.NTWINE_LIVE_STATUS === "0")
  const liveStatus = createLiveStatus({
    storage,
    get complete() { return liveStatusModel() },
    readMessages: (sessionId, forkAnchor) => readTranscriptYielding(project, sessionId, forkAnchor),
    onStatus: () => board.refresh(),
    onError: (slug, error) => process.stderr.write(`[ntwine] working status of ${slug} failed: ${error instanceof Error ? error.message : String(error)}\n`),
    ...(Number.isInteger(liveStatusMs) && liveStatusMs > 0 ? { intervalMs: liveStatusMs, firstMs: Math.min(liveStatusMs, 20_000) } : {}),
  })
  // The thread behind a cross-session message's sender socket (session-peer.ts), searched across every
  // project this process has open — a coordinator in one repo can steer a thread in another.
  const sessionPeerResolver = createSessionPeerResolver({
    findThread: (sessionId) => {
      // This project first and always: the launching project's context is built before the tenant map
      // holds anything, so the map alone would not list it.
      const open = [{ project, storage }, ...(opts.activeTenants?.() ?? []).filter((t) => t.project.id !== project.id)]
      for (const tenant of open) {
        const rows = tenant.storage?.allSessions() ?? []
        const row = rows.find((r) => r.session_id === sessionId || r.agent_session_id === sessionId || r.transcript_id === sessionId)
        if (!row) continue
        const shown = resolveSessionTitle(row, undefined)
        return {
          projectId: tenant.project.id,
          project: findProjectById(tenant.project.id, home)?.slug,
          slug: row.slug,
          title: shown.aiTitle || shown.title || row.slug,
        }
      }
      return undefined
    },
    memoryFile: join(ntwineRoots().state, "session-peers.json"),
  })
  const tailer = createTailer({
    project,
    storage,
    bus,
    onCrossSessionMessage: (peer) => void sessionPeerResolver(peer, project.id),
    backendFor,
    codexModels: () => readCodexModels(undefined, opts.codexVersion),
    onChange: () => board.refresh(),
    // A turn that wore a working status gets a rest status even when no reply moved the conversation.
    onTurnDone: (row) => periodicStatus.onTurnDone(row, { force: liveStatus.onTurnDone(row) }),
    onTurnActivity: (row) => liveStatus.onActivity(row),
    // The Codex first-output marker is a dispatch-time name like any other: held to the project's
    // uniqueness rule before it persists (thread-names.ts).
    distinctTitle: (slug, title, source) => threadNamer.distinct(title, source ?? "", slug),
    onTranscriptChange: (slugs) => transcriptChange.emit(slugs),
    // The journal's word on whether a deferred permission request has been answered — the transcript
    // only says so once the approved tool call returns.
    permissionSettled: (slug, sessionId, markerAt) =>
      storage.interactions.settledSince({ projectId: project.id, threadSlug: slug, sessionId }, markerAt),
    // The SDK's own reading of a headless broker session: its turn (so the fold's 5s unknown-stop_reason
    // guess need not run out before a finished turn reaches the queue) and its event count (so a tick
    // can tell the provider has reported activity its own disk write has not caught up with yet).
    runtimeLiveness: claudeRuntimeIngest ? (sessionId) => claudeRuntimeIngest.liveness(sessionId) : undefined,
    // The provider's own report of what each sub-agent/background op is doing, and which ones it says
    // are finished — the payload the protocol used to discard, which is why the tailer had to
    // reconstruct child lifecycle from English prose. See applyRuntimeTasks for the authority split.
    runtimeTasks: claudeRuntimeIngest ? (sessionId) => claudeRuntimeIngest.tasks(sessionId) : undefined,
    // The model's context SIZE for a broker Claude session. Claude names it nowhere on disk, so this
    // is the only path to the context reading's denominator for a Claude row (codex names its own on
    // every token_count and needs nothing here).
    runtimeContextWindow: claudeRuntimeIngest ? (sessionId) => claudeRuntimeIngest.contextWindow(sessionId) : undefined,
    // Codex's live background execs, off the app-server item stream. The counterpart of runtimeTasks
    // for the other provider — and the only source there is, since a codex exec's `processId` (the id
    // its × addresses) never reaches the rollout the tailer folds.
    codexBackgroundExecs: codexAppServer ? (slug, sessionId) => codexAppServer.backgroundExecs(slug, sessionId) : undefined,
    // Where a codex session runs, so a relative `workdir` resolves where Codex resolved it.
    codexSessionCwd: codexAppServer ? (slug, sessionId) => codexAppServer.binding(slug, sessionId)?.cwd : undefined,
  })
  resources.tailer = tailer
  opts.startup?.afterPhase?.("tailer")
  permissionAnswered = (slug) => tailer.permissionAnswered?.(slug)
  // The bridge is the authority on whether a codex app-server TURN is actually running — a rollout
  // frozen by a dead app-server reads "in-flight" forever on its own. Without this the board spins
  // such a thread on `running` and never queues it (live stall 2026-07-22).
  // Thread terminals. Created before the board because the board attaches them to their threads' rows;
  // every run state change is an overlay refresh. A refresh after the board has stopped (a run exiting
  // during shutdown) is a no-op, not an error. Constructing it loads nothing native: node-pty is
  // imported on a terminal's first start, so a host without it still serves this project.
  const terminalRunner = createTerminalRunner({
    storage,
    onChange: () => {
      try {
        board?.refresh()
      } catch {
        // ProducerStoppedError — the board is gone, and so is anyone to show the change to.
      }
    },
  })
  // Late-bound: the schedule service needs the dispatcher, which needs the board.
  let schedules: ScheduleService | undefined
  board = createBoard(project, storage, bus, tailer, bootId, {
    scheduleRef: (row) => schedules?.threadRef(row),
    threadTerminals: () => terminalRunner.byThread(),
    codexTurnLiveness: (slug, sessionId) => codexAppServer?.turnLiveness(slug, sessionId),
    // Headless-stall signal for a broker row: the ownerless daemon's record. Absent bridge ⇒ default
    // "alive" so a bridge-less server never falsely crash-cards a broker row (there are none anyway).
    claudeBrokerDaemonAlive: claudeBroker ? (sessionId) => claudeBroker.isDaemonAlive(sessionId) : undefined,
    claudeModels: peekClaudeModels,
  })
  resources.board = board
  // The pinned runtime's catalogue, resolved once so the board can say which threads run an older edition
  // than their family now resolves to, and so the upgrade at compaction does not wait for a browser to
  // ask for it first. The board re-derives the moment it lands. Same gate as the quota warm-up: a
  // disposable test stack never spawns the runtime on its own.
  contextUnsubscribers.push(onClaudeModelsResolved(() => board.refresh()))
  if (process.env.NTWINE_WAKERS_OFF !== "1") {
    void readClaudeModels({ claudeBin: opts.claudeBin, cwd: workDirOf(project), log: (message) => ntwineLog.warn("server", message) })
  }
  opts.startup?.afterPhase?.("board watcher")
  // Its own completer with a short timeout and room for four at once (chooseEffort below).
  const effortModel = model(createClaudeOneShot({ claudeBin: opts.claudeBin, cwd: workDirOf(project), timeoutMs: 20_000, concurrency: 4 }), process.env.NTWINE_AUTO_EFFORT === "0")
  const dispatcher = createDispatcher({
    project,
    storage,
    board,
    getSettings: () => getSettings(storage, home),
    // The prompt box's machine-wide profile, read fresh per dispatch so the most recent pick anywhere —
    // any project, any tab, a thread's own profile control — is what a model-less dispatch launches on.
    dispatchProfile: (kind) => getDispatchPreferences(storage, getSettings(storage, home), home, readCodexModels(undefined, opts.codexVersion))[kind] ?? {},
    codexModels: () => readCodexModels(undefined, opts.codexVersion),
    claudeBin: opts.claudeBin,
    // The Fable fallback's quota reading — the same cached snapshot the status row polls.
    readClaudeQuota: async () => (await readQuota({ claudeBin: opts.claudeBin })).claude,
    backendFor,
    codexAppServer,
    acpBridge,
    claudeBroker,
    editors: opts.editors,
    threadNamer,
    // "auto" effort → a level read off the prompt by Haiku, before launch (effort-chooser.ts). Its own
    // completer with a short timeout: it blocks the dispatch, so it must never queue behind the namer's
    // mints, and a slow answer falls back to a fixed level. With
    // NTWINE_AUTO_EFFORT=0 the model is skipped and "auto" launches on that fixed level.
    chooseEffort: createEffortChooser({
      get complete() { return effortModel() },
      log: (message) => ntwineLog.warn("dispatch", `auto effort: ${message}`),
    }),
    // Auth preflight (claude-auth plan, Slice A): Claude reads its local credential and confirms only
    // a positive signed-out against its CLI (readClaudePreflightAuth — the comment there records why
    // the CLI must not sit on the signed-in path); Codex reads the local auth.json/env. Both block
    // only on a positive "signed-out" — everything else fails open.
    preflightAuth: (kind) =>
      kind === "codex"
        ? Promise.resolve(readCodexAuthState())
        : readClaudePreflightAuth({ claudeBin: opts.claudeBin, cwd: workDirOf(project) }),
    preflightCodexBinary: () => readCodexBinaryState(opts.codexBin ?? "codex"),
  })

  // SCHEDULED THREADS (ARCHITECTURE.md § Scheduled threads). One held-thread starter per project, shared by the
  // router and the scheduler so its one-launch-at-a-time guard sees every launch.
  const heldStarter = createHeldThreadStarter({ dispatcher, board })
  schedules = createScheduleService({
    project,
    storage,
    dispatcher,
    starter: heldStarter,
    board,
    nameHolder: (name, exceptSlug) => threadNamer.holder(name, exceptSlug),
    // The overlap check's reading: the BOARD's view of the previous run (deriveRuntime turns a dead
    // daemon's row into `exited`; raw telemetry would read it in flight forever) and whether the tailer
    // vouches for it yet.
    threadView: (slug) => ({ view: board.refresh().threads.find((t) => t.id === slug), vouched: telemetryVouched(tailer.get(slug)) }),
    // Read on every board build, once per scheduled row, so it is cached; this process is the only writer.
    clientZone: () => {
      if (!clientZoneByHome.has(home)) clientZoneByHome.set(home, readMachineConfig(home, CLIENT_ZONE_CONFIG_KEY, z.string()))
      return clientZoneByHome.get(home)
    },
    setClientZone: (tz) => {
      writeMachineConfig(home, CLIENT_ZONE_CONFIG_KEY, tz)
      clientZoneByHome.set(home, tz)
    },
    awake: processAwakeClock,
    log: (message) => ntwineLog.info("schedules", message),
    // A schedule created with a provisional title (`titleAuto`) is renamed by the thread namer, compare-and-
    // set (schedules.ts autoTitle). With NTWINE_THREAD_NAMER=0
    // the namer has no model, and the provisional title stays. A getter, read at each schedule's save.
    get nameFor() { return threadNamer.available ? (source: string, exceptSlug?: string) => threadNamer.name(source, exceptSlug) : undefined },
  })
  const scheduleService = schedules
  // Its own completer, so reading a schedule never queues behind a fleet's name mints. Same switch as the
  // namer: NTWINE_THREAD_NAMER=0 leaves it no model, and the box reads every
  // prompt as having no schedule in it. The prompt box reads as the human
  // types — a burst of reads, one at a time — so it keeps one CLI started ahead for the next read (`spare`,
  // claude-oneshot.ts), closed after a minute unused. 30s, down from 90s: one read at a time means a
  // stuck read holds up every read behind it, and the box gives up on a read at submit after 15s anyway.
  const scheduleModel = model(createClaudeOneShot({ claudeBin: opts.claudeBin, cwd: workDirOf(project), model: SCHEDULE_INTERPRETER_MODEL, timeoutMs: 30_000, concurrency: 1, spare: { idleMs: 60_000 } }), namerOff)
  const scheduleInterpreter = createScheduleInterpreter({
    get complete() { return scheduleModel() },
  })

  // COMMAND WATCHES (`ntwinectl watch-command`): checks run in the project's working folder with the server's own
  // environment — scrubbed of the toolchain injection a provider child is scrubbed of — plus the thread's
  // Ntwine identity and `ntwinectl` on PATH, so a check may itself call `ntwinectl`. Everything about the
  // process and the gate is in command-watch.ts.
  const commandWatches = createCommandWatchService({
    // Where the thread's worker works: the project root, or the home folder for the Home workspace.
    cwd: workDirOf(project),
    env: (slug) => {
      const base = sanitizeProviderChildEnvironment(process.env)
      const cli = resolveNtwineCli(ntwineMcpTarget)
      if (!cli) {
        return commandWatchEnvironment(base, {
          NTWINE_STATE_DIR: ntwineMcpTarget.stateDir,
          ...(ntwineMcpTarget.serverLock ? { NTWINE_SERVER_LOCK: ntwineMcpTarget.serverLock } : {}),
          ...(ntwineMcpTarget.projectId ? { NTWINE_PROJECT_ID: ntwineMcpTarget.projectId } : {}),
          NTWINE_THREAD_SLUG: slug,
        })
      }
      const env = commandWatchEnvironment(base, ntwineCliEnv(cli, slug))
      const defined = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"))
      return withNtwineCliOnPath(defined, cli)
    },
  })

  // Durable timer waker + legacy pr/ci compatibility. Reuses the SAME resume path as followUp;
  // boot-safe because it only fires on a condition it witnesses cross.
  // The runtime budget's kill (scheduler SOURCE 13) is the operator's × — one shared body in
  // shell-stop.ts, so a budget stop reaches the provider and tells the worker exactly as a click does.
  const shellStopDeps = { project, storage, tailer, claudeBroker, codexAppServer, board, getSettings: () => getSettings(storage, home) }
  const scheduler = createScheduler({
    storage,
    tailer,
    scheduledThreads: scheduleService,
    shellControl: {
      stoppable: (slug, id) => backgroundShellStoppable(shellStopDeps, slug, id),
      stop: (slug, id, reason, stopOpts) => stopBackgroundShell(shellStopDeps, slug, id, reason, stopOpts),
    },
    commandWatches,
    // Second wake source: every thread a subscription window cut off mid-turn gets its own "continue"
    // once that window rolls, over this same delivery path. The quota reader supplies the fallback
    // instant for a weekly limit, whose message text carries a clock but no date; readQuota memoizes,
    // so consulting it per tick costs a live request only every few minutes. Read through the resolved
    // runtimes, as the quota RPC does: a bare call would start whatever `codex` is first on PATH.
    readQuota: () => readQuota({ claudeBin: opts.claudeBin, codexBin: opts.codexBin }),
    fableFallback: () => getSettings(storage, home).fableFallback === true,
    refreshBoard: () => board.refresh(),
    // The only runtime that can answer is the broker: its daemon record is on disk while the daemon
    // lives and is unlinked when it dies (liveBrokerRecords checks the pid), so "did the process that
    // took this wake survive" is one directory read. Codex and any row whose session moved on answer
    // "unknown", which keeps their wakes on the delivered-on-return path they always had.
    wakeRuntimeState: (slug, sessionId) => {
      const row = storage.getSession(slug)
      if (!row || row.session_id !== sessionId || row.backend !== "claude" || row.claude_runtime !== "broker" || !claudeBroker) return "unknown"
      return liveBrokerRecords(project.stateDir).some((r) => r.sessionId === sessionId) ? "alive" : "dead"
    },
    resume: (slug, message, deliveryId) => {
      const deliveryMessage = `${message}\n\n${wakeDeliveryToken(deliveryId)}`
      const row = storage.getSession(slug)
      // Codex wake: deliver over the app-server bridge (adopting a legacy TUI-era rollout first, then
      // reactivating the persisted thread), exactly like the followUp RPC. Codex never used the legacy
      // `resumeThread` path — it is CLAUDE-only, so a codex row must never reach it even when the
      // bridge is absent (only possible in a test context): drop the wake loudly instead of degrading.
      if (row?.backend === "codex") {
        const bridge = codexAppServer
        if (!bridge) {
          process.stderr.write(`[ntwine] codex wake for ${slug} dropped: the app-server bridge is unavailable\n`)
          return
        }
        return deliverCodexWake({ bridge, storage, cwd: workDirOf(project), row, slug, deliveryMessage, deliveryId })
      }
      // ACP wake: the same call the followUp RPC makes — the bridge re-opens the session if the child
      // is gone and queues behind a running turn. A fresh session id (the agent could not load the old
      // one) is re-pinned so the next resume asks for the right one.
      if (row?.backend === "acp") {
        return acpBridge.followUp({
          threadSlug: slug, sessionId: row.session_id, cwd: workDirOf(project),
          agentId: row.acp_agent ?? "", modelId: acpModelIdFromModel(row.model), effort: row.effort, acpSessionId: row.agent_session_id, text: deliveryMessage, deliveryId,
        }).then((r) => {
          if (r.acpSessionId !== row.agent_session_id) storage.setAgentSession(slug, r.acpSessionId)
          if (row.exited === 1) storage.setExitedIfCurrent(slug, row.session_id, row.runtime_generation ?? 0, false)
        })
      }
      // Broker Claude wake: no local process to inject into — deliver over the bridge (reconnect the
      // live daemon or cold-resume a dead one), exactly like the followUp RPC. Never reaches the legacy
      // `resumeThread` path.
      if (row?.backend === "claude" && row.claude_runtime === "broker") {
        if (!claudeBroker) {
          process.stderr.write(`[ntwine] claude-broker wake for ${slug} dropped: the session broker is unavailable\n`)
          return
        }
        // The upgrade at compaction, exactly as the followUp RPC takes it (claude-model-upgrade.ts): a
        // wake is the first input after a compaction as often as an operator's message is.
        const upgradeCandidate = claudeUpgradeCandidate({ stateDir: project.stateDir, projectId: project.id, storage, telemetry: tailer.get(slug) }, row)
        const upgrade = upgradeCandidate
          ? claudeModelUpgradeDue(upgradeCandidate, { catalogue: peekClaudeModels(), nowMs: Date.now(), serverStartedAtMs: SERVER_STARTED_AT_MS })
          : undefined
        if (upgrade?.due) ntwineLog.info("server", `${slug}: compacted on ${upgrade.from}; this wake starts a fresh worker on ${upgrade.to}`)
        return deliverClaudeBrokerWake({
          bridge: claudeBroker,
          slug,
          cwd: workDirOf(project),
          capabilities: workerCapabilities(opts.editors, workDirOf(project)),
          boardDir: project.dir,
          row,
          settings: getSettings(storage, home),
          deliveryMessage,
          // Recomputed here rather than carried on the delivery: the outbox stores a message, not a
          // runtime decision, and the tail is the live answer to "is this thread still behind a wall
          // its own process is enforcing".
          freshProcess: upgrade?.due === true || needsFreshProcessForLimit(
            tailer.get(slug)?.limitFault,
            Date.now(),
            (tailer.get(slug)?.subAgents ?? []).some((agent) => agent.state === "running"),
          ),
        }).then(() => {
          // A delivered wake resumed the worker (warm or cold), so a deliberate stop the row still
          // records is over — the same correction the followUp RPC makes, for the same reason: no
          // other path ever wrote `exited = 0` back, and a woken thread ran for hours under a column
          // that called it exited (2026-09-03).
          if (row.exited === 1) storage.setExitedIfCurrent(slug, row.session_id, row.runtime_generation ?? 0, false)
        })
      }
      resumeThread(
        { project, storage, board, getSettings: () => getSettings(storage, home), backendFor },
        slug,
        deliveryMessage,
        undefined,
        // Same latch, other transport: a pre-cutover worker that hit the wall needed a relaunch, not a
        // message injected into a process that was refusing input. Nothing reaches this arm with a live
        // transport any more — `resumeThread` throws for every row that can get here — so the flag is
        // carried for the shape of the call, not for a path that runs.
        {
          freshProcess: needsFreshProcessForLimit(
            tailer.get(slug)?.limitFault,
            Date.now(),
            (tailer.get(slug)?.subAgents ?? []).some((agent) => agent.state === "running"),
          ),
        },
      )
    },
  })
  resources.scheduler = scheduler
  opts.startup?.afterPhase?.("wake scheduler")

  // Reclaim the memory an IDLE broker thread holds — the `claude` CLI, the broker daemon, the ntwine MCP
  // server, and whatever MCP servers the PROJECT itself configured — by retiring the daemon of a thread
  // that has rested past the prompt-cache TTL and has nothing outstanding. The 504 MB figure that
  // motivated this was measured 2026-08-19, when ntwine auto-mounted chrome-devtools into every worker
  // (159 MB of that total); ntwine mounts no browser since 2026-08-26, so a thread in a project that
  // brings none rests nearer ~345 MB, and one that brings a browser is back at the old number only once it has
  // used it — a project's stdio MCP servers start on first use since 2026-10-05 (lazy-mcp-host.ts). It is not an end: the transcript
  // is on disk and the next input (an operator message, a fired timer, a recurring prompt, a PR event —
  // all of which route through the bridge's followUp) cold-resumes it with `resume: true`. Above the TTL
  // that resume costs no extra tokens, because the cache is already gone.
  //
  // Wired here, after the tailer, because the sweep's whole safety predicate is read off it. Requires
  // the bridge for the same reason: without one there is no daemon to retire.
  // NTWINE_HIBERNATE_OFF=1 disables it (mirrors NTWINE_ORPHAN_REAPER_OFF); NTWINE_HIBERNATE_IDLE_MINUTES
  // moves the threshold.
  if (claudeBroker && hibernationEnabled()) {
    contextUnsubscribers.push(startThreadHibernator({
      liveDaemons: () => liveBrokerRecords(project.stateDir).map((r) => ({ sessionId: r.sessionId, createdAt: r.createdAt })),
      rows: () => storage.allSessions(),
      telemetry: (slug) => tailer.get(slug),
      pendingInteractions: (threadSlug, sessionId) =>
        storage.interactions.listPending({ projectId: project.id, threadSlug, sessionId }).length,
      retire: (input) => claudeBroker.retireDaemon(input),
      log: (m) => ntwineLog.info("hibernate", m),
    }))
  }
  opts.startup?.afterPhase?.("thread hibernation")

  const appContext: AppContext = {
    bootId,
    project,
    bus,
    transcriptChange,
    storage,
    interactions: storage.interactions,
    codexAppServer,
    acpBridge,
    claudeBroker,
    claudeRuntimeIngest,
    board,
    tailer,
    dispatcher,
    threadNamer,
    scheduler,
    probePr: probePrReadable,
    probeIssue: probeIssueReadable,
    commandWatches,
    stopSubscriptions,
    backendFor,
    getSettings: () => getSettings(storage, home),
    setSettings: (s) => setSettings(storage, s, home),
    resetSettings: () => resetSettings(storage, home),
    getDispatchPreferences: (codexModels) => getDispatchPreferences(storage, getSettings(storage, home), home, codexModels),
    setDispatchPreference: (update, codexModels) =>
      setDispatchPreference(storage, getSettings(storage, home), home, update, codexModels),
    activeTenants: opts.activeTenants,
    openProject: opts.openProject,
    sessionPeerThread: (peer) => sessionPeerResolver(peer, project.id),
    teardownProject: opts.teardownProject,
    launchProjectId: opts.launchProjectId,
    editors: opts.editors,
    // Derived from the state dir, never from `homedir()`, so a sandboxed server audits into its own
    // sandbox (the reason serverAddressPathForStateDir exists).
    audit: fileAuditLog(auditLogPathForStateDir(project.stateDir)),
    claudeBin: opts.claudeBin,
    codexBin: opts.codexBin,
    terminalRunner,
    schedules: scheduleService,
    scheduleInterpreter,
    startHeldThread: (row, prompt, profile) => scheduleService.startHeldRow(row, prompt, profile),
    codexVersion: opts.codexVersion,
  }
  startThreadRetention(appContext, contextUnsubscribers)
  return appContext
}

/**
 * Settings → "Delete done threads after": apply it to this project once shortly after boot and hourly
 * after that (thread-retention.ts). Read fresh each pass, so a changed period takes effect within the
 * hour without a restart. The delete itself is the router's (`deleteExpiredDoneThreads`), imported at
 * fire time because router.ts already imports this module.
 */
function startThreadRetention(ctx: AppContext, unsubscribers: (() => void)[]): void {
  let stopped = false
  const sweep = async () => {
    const days = ctx.getSettings().deleteDoneThreadsUntouchedDays ?? 0
    if (stopped || !(days > 0)) return
    const { deleteExpiredDoneThreads } = await import("./router.ts")
    if (stopped) return
    const deleted = await deleteExpiredDoneThreads(ctx, days)
    if (deleted) ntwineLog.info("thread-retention", `${ctx.project.name}: deleted ${deleted} done thread${deleted === 1 ? "" : "s"} untouched for ${days}d`)
  }
  const run = () => void sweep().catch((error) => ntwineLog.warn("thread-retention", `${ctx.project.name}: sweep failed: ${String(error)}`))
  const first = setTimeout(run, RETENTION_FIRST_SWEEP_MS)
  const timer = setInterval(run, RETENTION_SWEEP_INTERVAL_MS)
  first.unref?.()
  timer.unref?.()
  unsubscribers.push(() => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  })
}
