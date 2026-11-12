import { execFileSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { hostname, networkInterfaces, tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import {
  type PeerListener,
  type PeerPairCode,
  type PeerPingResult,
  type PeersState,
  type PeerView,
  type ThreadMovePreview,
  type ThreadMoveResult,
  type ThreadMoveStamp,
} from "@ntwine/shared"
import type { AppContext } from "./context.ts"
import { recordAudit, withRequestOrigin, type AuditLog, type RequestOrigin } from "./audit.ts"
import { discoverTranscriptDir } from "./discover.ts"
import { editedFilesOf } from "./edited-files.ts"
import { log } from "./logging.ts"
import {
  frameMessage,
  macsMatch,
  normalizePairCode,
  openRequest,
  pairMac,
  peerFingerprint,
  peerIdOf,
  PeerCryptoError,
  publicKeyObject,
  requestSender,
  sealRequest,
  unframeMessage,
  type PeerKeyPair,
} from "./peer-crypto.ts"
import {
  createPairCodes,
  DEFAULT_PEER_PORT,
  loadOrCreatePeerKey,
  openPeerStore,
  peersFilePath,
  peerView,
  type PeerRecord,
  type PeerStore,
} from "./peer-store.ts"
import { cwdSlug, workDirOf } from "./project.ts"
import { isBrokerClaudeRow, isHeldRow, type SessionRow } from "./storage.ts"
import { hibernationVerdict, type HibernationBlock } from "./thread-hibernation.ts"
import { newestTranscriptCwd } from "./thread-cwd.ts"
import { BundleError, unpackBundle } from "./thread-bundle.ts"
import {
  exportThread,
  importThread,
  markMovedAway,
  movedAwayBlock,
  movedStamp,
  MoveRefusal,
  parseManifest,
  pendingWakes,
  slugStanding,
  type MoveGit,
} from "./thread-move.ts"
import { readThreadTranscript } from "./transcript.ts"
import { restoreWip, revertMovedPaths, snapshotWip, threadCheckout, writeWipBundle } from "./thread-wip.ts"

// MOVING A THREAD BETWEEN TWO PAIRED MACHINES — the machine-level service (plans/thread-handoff.md).
//
// One per server, like the editor bridge: a pairing is between machines, and the routes it answers
// (`/_ntwine/peer/v1/*`) are machine-scoped. It owns this machine's peer key, the paired machines, the
// short-lived pairing codes, the optional network listener, and both ends of a move: the ORIGIN side
// (`preview`, `move`), driven by the human through a project's router, and the DESTINATION side
// (`handle`), driven by the other machine over the encrypted channel (peer-crypto.ts).

export const PEER_ROUTE_PREFIX = "/_ntwine/peer/v1/"
/** A paired machine's whole request: the bundle plus its envelope. Matches BUNDLE limits with room. */
const MAX_CALL_BYTES = 400 * 1024 * 1024
const MAX_PAIR_BYTES = 16 * 1024
/** How far a request's own clock may be from ours, and how long its id is remembered against a replay. */
const REPLAY_WINDOW_MS = 5 * 60_000
const PROTOCOL = 1

export interface PeerServiceDeps {
  home: string
  /** The machine-wide audit trail. */
  audit?: AuditLog
  /** Every registered project, for matching a project by its git remotes. */
  workspaces: () => readonly { id: string; path: string; name?: string; stale?: boolean }[]
  /** Open a registered project's context (index.ts tenants.activate). */
  openProject: (projectId: string) => Promise<AppContext | undefined>
  /** Overrides for tests. */
  name?: string
  fetch?: typeof fetch
  storePath?: string
  /** Start the network listener when the saved setting says so. Off in tests unless asked. */
  startListener?: boolean
}

export interface PeerService {
  state(): PeersState
  mintPairCode(): PeerPairCode
  join(url: string, code: string): Promise<PeerView>
  unpair(id: string): Promise<void>
  setAddress(id: string, url: string): PeerView
  setListener(enabled: boolean, port?: number): Promise<PeerListener>
  ping(id: string): Promise<PeerPingResult>
  preview(ctx: AppContext, slug: string, peerId: string): Promise<ThreadMovePreview>
  move(ctx: AppContext, slug: string, peerId: string): Promise<ThreadMoveResult>
  /** Clear a move whose answer never came back, keeping the thread on this machine. */
  keepHere(ctx: AppContext, slug: string): void
  /** Why this thread may not run here right now, or undefined. Every path that would run it asks. */
  blocked(projectId: string, row: Pick<SessionRow, "slug" | "moved_to"> | undefined): string | undefined
  /** `/_ntwine/peer/v1/*`, from the board's port or the network listener. */
  handle(request: Request, origin: RequestOrigin): Promise<Response>
  close(): Promise<void>
}

/** Thrown when a request was sent and no answer came: the other machine may or may not have acted. */
class UnconfirmedError extends Error {}

// ---- git remotes: how two machines agree they hold the same project ----

/**
 * A remote URL as `host/owner/repo` (lowercased, no scheme, user, port or `.git`), or `file:<realpath>`
 * for a remote on this disk. Two checkouts are the same project when they share one.
 */
export function remoteIdentity(url: string, cwd: string): string | undefined {
  const trimmed = url.trim()
  if (!trimmed) return undefined
  const clean = (path: string) => path.replace(/\.git\/?$/, "").replace(/\/+$/, "").replace(/^\/+/, "").toLowerCase()
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(trimmed)
  if (scp && !isAbsolute(trimmed)) return `${scp[1]!.toLowerCase()}/${clean(scp[2]!)}`
  const parsed = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(trimmed)
  if (parsed && parsed[1]!.toLowerCase() !== "file") return `${parsed[2]!.toLowerCase()}/${clean(parsed[3] ?? "")}`
  const local = parsed ? decodeURIComponent(trimmed.replace(/^file:\/\//i, "")) : trimmed
  const absolute = resolve(cwd, local)
  try {
    return `file:${realpathSync(absolute).replace(/\/+$/, "").replace(/\.git$/, "")}`
  } catch {
    return `file:${absolute.replace(/\/+$/, "").replace(/\.git$/, "")}`
  }
}

export function remoteIdentities(dir: string): string[] {
  let out: string
  try {
    out = execFileSync("git", ["remote", "-v"], { cwd: dir, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return []
  }
  const ids = new Set<string>()
  for (const line of out.split("\n")) {
    const url = line.split(/\s+/)[1]
    const id = url ? remoteIdentity(url, dir) : undefined
    if (id) ids.add(id)
  }
  return [...ids].sort()
}

// ---- the resting check, in the operator's words ----

const RESTING_BLOCKS: Partial<Record<HibernationBlock, string>> = {
  "no-telemetry": "This thread's state cannot be read yet; try again in a moment",
  "no-transcript": "This thread has no transcript to move yet",
  "turn-in-flight": "Wait for the thread to come to rest",
  "awaiting-a-human": "Answer the thread's open approval or question in the composer first",
  "pending-approval": "Answer the thread's open approval first",
  "sub-agents": "Wait for the thread's sub-agents to finish",
  "background-shells": "Wait for the thread's background shells to finish, or stop them",
  "undelivered-input": "Wait for the last message to reach the worker",
}

function selfAddresses(listener: { enabled: boolean; port: number }, name: string): string[] {
  if (!listener.enabled) return []
  const out = [`http://${name}.local:${listener.port}`]
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue
      out.push(`http://${entry.address}:${listener.port}`)
    }
  }
  return out
}

function machineName(): string {
  return hostname().replace(/\.local$/i, "").split(".")[0] || "this machine"
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const parsed = new URL(withScheme)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("An address starts with http:// or https://")
  return `${parsed.protocol}//${parsed.host}`
}

async function readBody(request: Request, max: number): Promise<Buffer | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "NaN")
  if (Number.isFinite(declared) && declared > max) return undefined
  if (!request.body) return Buffer.alloc(0)
  const reader = request.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

const plain = (status: number, text: string) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } })

export function createPeerService(deps: PeerServiceDeps): PeerService {
  const fetchImpl = deps.fetch ?? fetch
  const key: PeerKeyPair = loadOrCreatePeerKey(deps.home)
  const selfId = peerIdOf(key.publicKey)
  const name = deps.name ?? machineName()
  const store: PeerStore = openPeerStore(deps.storePath ?? peersFilePath(deps.home))
  const codes = createPairCodes()
  const seen = new Map<string, number>()
  /** Threads with a move in flight on this machine, `<projectId>:<slug>`, to the destination's name. */
  const moving = new Map<string, string>()
  /** Imports in flight here, so two deliveries of one move never interleave. */
  const importing = new Set<string>()
  const identityCache = new Map<string, { at: number; ids: string[] }>()
  let listener: { server: Server; port: number } | undefined
  let listenerError: string | undefined

  const audit = (action: "peerPair" | "peerUnpair" | "threadMoveOut" | "threadMoveIn", outcome: "ok" | "refused", fields: { error?: string; project?: { id: string | null; dir: string | null }; thread?: string; detail?: Record<string, unknown> }) =>
    recordAudit(deps.audit, () => ({
      action,
      outcome,
      ...(fields.error ? { error: fields.error } : {}),
      project: fields.project ?? { id: null, dir: null },
      ...(fields.thread ? { thread: fields.thread } : {}),
      ...(fields.detail ? { detail: fields.detail } : {}),
    }))

  const peerRef = (record: Pick<PeerRecord, "id" | "name">) => ({ id: record.id, name: record.name, fingerprint: peerFingerprint(record.id) })

  const requirePeer = (id: string): PeerRecord => {
    const record = store.get(id)
    if (!record) throw new Error("That machine is not paired with this one")
    if (!record.url) throw new Error(`No address is saved for ${record.name}. Add one in Settings → Other machines`)
    return record
  }

  // ---- outbound ----

  async function call(peer: PeerRecord, op: string, args: unknown, options: { blob?: Buffer; timeoutMs?: number } = {}): Promise<unknown> {
    const plaintext = frameMessage({ op, id: randomUUID(), ts: Date.now(), from: { name }, args }, options.blob)
    const sent = sealRequest(key, Buffer.from(peer.publicKey, "base64url"), plaintext)
    let response: Response
    try {
      response = await fetchImpl(`${peer.url}${PEER_ROUTE_PREFIX}call`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(sent.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      })
    } catch (error) {
      const message = `${peer.name} did not answer at ${peer.url} (${error instanceof Error ? error.message : String(error)})`
      store.update(peer.id, { lastError: message })
      // A request that was never sent cannot have been acted on; one that timed out might have been.
      throw options.blob ? new UnconfirmedError(message) : new Error(message)
    }
    const body = Buffer.from(await response.arrayBuffer())
    if (response.status !== 200) {
      const text = body.toString("utf8").slice(0, 300).trim()
      const message = response.status === 403 && text
        ? `${peer.name} refused this machine: ${text}`
        : `${peer.name} answered ${response.status} at ${peer.url}${text ? ` (${text})` : ""}`
      store.update(peer.id, { lastError: message })
      if (options.blob && response.status >= 500) throw new UnconfirmedError(message)
      throw new Error(message)
    }
    let head: { ok?: boolean; result?: unknown; error?: string }
    try {
      head = unframeMessage(sent.openResponse(body)).head as typeof head
    } catch {
      const message = `${peer.name}'s answer could not be verified`
      store.update(peer.id, { lastError: message })
      throw options.blob ? new UnconfirmedError(message) : new Error(message)
    }
    store.update(peer.id, { lastSeenAt: new Date().toISOString(), lastError: undefined })
    if (!head.ok) throw new Error(head.error ?? `${peer.name} refused`)
    return head.result
  }

  // ---- matching a project by remote ----

  function projectFor(identities: readonly string[]): { id: string; path: string; name: string } | undefined {
    const wanted = new Set(identities)
    for (const entry of deps.workspaces()) {
      if (entry.stale || !existsSync(entry.path)) continue
      const cached = identityCache.get(entry.path)
      const ids = cached && Date.now() - cached.at < 60_000 ? cached.ids : remoteIdentities(entry.path)
      identityCache.set(entry.path, { at: Date.now(), ids })
      if (ids.some((id) => wanted.has(id))) return { id: entry.id, path: entry.path, name: entry.name ?? basename(entry.path) }
    }
    return undefined
  }

  // ---- the origin side ----

  /** `ownMove`: asked from inside the move that holds this thread's in-flight slot, which must not refuse itself. */
  function localRefusal(ctx: AppContext, row: SessionRow | undefined, ownMove = false): string | undefined {
    if (!row) return "No such thread in this project"
    const away = ownMove ? movedAwayBlock(row.moved_to) : blocked(ctx.project.id, row)
    if (away) return away
    if (isHeldRow(row)) return "Start this thread before moving it"
    if (!isBrokerClaudeRow(row)) return "Only a Claude thread can move to another machine for now"
    if (workDirOf(ctx.project) !== ctx.project.dir) return "A thread in Home cannot move: Home is not a repository both machines share"
    // The hibernation gate without its memory clauses: nothing running, nothing owed to the worker.
    // An archived or stopped row is still a resting thread here, so it is read as an open one.
    let pendingInteractions = 1
    try {
      pendingInteractions = ctx.storage.interactions.listPending({ projectId: ctx.project.id, threadSlug: row.slug, sessionId: row.session_id }).length
    } catch { /* keep the refusal */ }
    const verdict = hibernationVerdict(
      { slug: row.slug, sessionId: row.session_id, row: { ...row, state: "open", archived: 0, exited: 0 }, telemetry: ctx.tailer.get(row.slug), pendingInteractions, daemonStartedAtMs: 0 },
      { nowMs: Date.now(), idleMs: 0, minDaemonAgeMs: 0 },
    )
    if (!verdict.hibernate) {
      const refusal = RESTING_BLOCKS[verdict.blockedBy]
      if (refusal) return refusal
    }
    if (pendingWakes(ctx.storage.db, ctx.project.id, row.slug) > 0) return "A message is on its way to the worker; wait for it to land"
    return undefined
  }

  function transcriptBucket(ctx: AppContext, sessionId: string): string {
    const bucket = cwdSlug(workDirOf(ctx.project))
    const logDir = join(deps.home, ".claude", "projects", bucket)
    if (existsSync(join(logDir, `${sessionId}.jsonl`))) return bucket
    const found = discoverTranscriptDir(logDir, sessionId)
    return found ? basename(found) : bucket
  }

  interface GitPlan {
    location: { kind: "main" | "worktree"; rel: string; root: string }
    snapshot: ReturnType<typeof snapshotWip>
    /** This thread's own uncommitted edits in the project's OTHER checkouts, relative to the main one: they stay. */
    elsewhere: string[]
  }

  function planGit(ctx: AppContext, row: SessionRow, bucket: string, peerName: string): GitPlan | { refused: string } | undefined {
    const workDir = workDirOf(ctx.project)
    if (!existsSync(join(workDir, ".git"))) return undefined
    const transcript = join(deps.home, ".claude", "projects", bucket, `${row.transcript_id ?? row.session_id}.jsonl`)
    const cwd = (existsSync(transcript) ? newestTranscriptCwd(transcript) : undefined) ?? workDir
    // Every file it wrote, oldest first: they say which checkout its work is in when its cwd does not, and
    // in the shared main checkout they are the only files that move.
    const editedPaths = editedFilesOf(readThreadTranscript(ctx.project, ctx.storage, row.slug, ctx.backendFor), workDir)
      .map((file) => (isAbsolute(file.path) ? file.path : join(workDir, file.path)))
    const { location, elsewhere } = threadCheckout({ cwd, mainCheckout: workDir, editedPaths })
    if ("refused" in location) return location
    try {
      const snapshot = snapshotWip({ root: location.root, kind: location.kind, editedPaths, message: `ntwine: uncommitted work of @${row.slug}, moved to ${peerName}` })
      return { location, snapshot, elsewhere }
    } catch (error) {
      return { refused: `This thread's checkout could not be read (${error instanceof Error ? error.message : String(error)})` }
    }
  }

  async function preview(ctx: AppContext, slug: string, peerId: string): Promise<ThreadMovePreview> {
    const record = store.get(peerId)
    if (!record) throw new Error("That machine is not paired with this one")
    const out: ThreadMovePreview = { peer: { id: record.id, name: record.name }, wipPaths: [], leftBehind: [] }
    const row = ctx.storage.getSession(slug)
    const refusal = localRefusal(ctx, row) ?? (record.url ? undefined : `No address is saved for ${record.name}. Add one in Settings → Other machines`)
    if (refusal) return { ...out, refusal }
    const identities = remoteIdentities(workDirOf(ctx.project))
    if (!identities.length) return { ...out, refusal: "This project has no git remote, so the other machine cannot find its copy of it" }
    const git = planGit(ctx, row!, transcriptBucket(ctx, row!.session_id), record.name)
    if (git && "refused" in git) return { ...out, refusal: git.refused }
    if (git) {
      out.checkout = { rel: git.location.rel, branch: git.snapshot.branch }
      out.wipPaths = git.snapshot.paths
      out.leftBehind = [...git.snapshot.leftBehind, ...git.elsewhere]
    }
    try {
      const prepared = await call(record, "prepare", { identities, slug, sessionId: row!.session_id }) as { project: string; dir: string }
      out.destination = { project: prepared.project, dir: prepared.dir }
    } catch (error) {
      out.refusal = error instanceof Error ? error.message : String(error)
    }
    return out
  }

  function stampFor(record: PeerRecord, moveId: string, pending?: boolean): ThreadMoveStamp {
    return { peerId: record.id, peerName: record.name, at: new Date().toISOString(), moveId, ...(pending ? { pending: true } : {}) }
  }

  async function move(ctx: AppContext, slug: string, peerId: string): Promise<ThreadMoveResult> {
    const record = requirePeer(peerId)
    const moveKey = `${ctx.project.id}:${slug}`
    const auditProject = { id: ctx.project.id, dir: workDirOf(ctx.project) }
    const existing = ctx.storage.getSession(slug)
    const retrying = movedStamp(existing?.moved_to)
    // A retry of a move whose answer was lost re-sends under the SAME id, which the destination
    // recognises; anything else that already left is refused by localRefusal below.
    const resumeId = retrying?.pending && retrying.peerId === record.id ? retrying.moveId : undefined
    if (moving.has(moveKey)) throw new Error(`This thread is already moving to ${moving.get(moveKey)}`)
    moving.set(moveKey, record.name)
    const workRoot = mkdtempSync(join(tmpdir(), "ntwine-move-"))
    try {
      const row = ctx.storage.getSession(slug)
      // A retry reads the thread as it was before its unfinished move stamped it.
      const refusal = localRefusal(ctx, row && resumeId ? { ...row, moved_to: null } : row, true)
      if (refusal) throw new MoveRefusal(refusal)
      if (!row) throw new MoveRefusal("No such thread in this project")
      const identities = remoteIdentities(workDirOf(ctx.project))
      if (!identities.length) throw new MoveRefusal("This project has no git remote, so the other machine cannot find its copy of it")
      await call(record, "prepare", { identities, slug, sessionId: row.session_id, ...(resumeId ? { moveId: resumeId } : {}) })

      // Stop the resting worker so nothing writes to the transcript while it is copied. Its next input
      // would cold-resume it from disk anyway; here there will be no next input.
      if (ctx.claudeBroker?.retireDaemon({ threadSlug: slug, sessionId: row.session_id })) {
        for (let waited = 0; waited < 5_000 && ctx.claudeBroker.isDaemonAlive(row.session_id); waited += 100) await new Promise((done) => setTimeout(done, 100))
      }

      const bucket = transcriptBucket(ctx, row.session_id)
      const git = planGit(ctx, row, bucket, record.name)
      if (git && "refused" in git) throw new MoveRefusal(git.refused)
      let gitPayload: (MoveGit & { bundle: Buffer }) | null = null
      if (git) {
        const file = join(workRoot, "wip.bundle")
        writeWipBundle({ root: git.location.root, wip: git.snapshot.wip, file })
        gitPayload = { rel: git.location.rel, branch: git.snapshot.branch, head: git.snapshot.head, wip: git.snapshot.wip, paths: git.snapshot.paths, bundle: readFileSync(file) }
      }
      const moveId = resumeId ?? randomUUID()
      const exported = exportThread({
        db: ctx.storage.db,
        project: { id: ctx.project.id, name: ctx.project.name, dir: ctx.project.dir, workDir: workDirOf(ctx.project), stateDir: ctx.project.stateDir },
        bucket,
        slug,
        home: deps.home,
        moveId,
        git: gitPayload,
      })

      // From here the thread runs nowhere until the destination answers: a send, a wake or a reopen all
      // refuse on this stamp, and it survives a restart of this server.
      if (!resumeId) {
        ctx.storage.db.prepare("UPDATE session SET moved_to = ? WHERE project_id = ? AND slug = ?").run(JSON.stringify(stampFor(record, moveId, true)), ctx.project.id, slug)
      }
      let imported: { slug: string; notes: string[] }
      try {
        imported = await call(record, "import", { identities, moveId }, { blob: exported.blob, timeoutMs: 15 * 60_000 }) as { slug: string; notes: string[] }
      } catch (error) {
        if (!(error instanceof UnconfirmedError)) {
          ctx.storage.db.prepare("UPDATE session SET moved_to = NULL WHERE project_id = ? AND slug = ?").run(ctx.project.id, slug)
        }
        throw error
      }

      markMovedAway(ctx.storage.db, ctx.project.id, slug, stampFor(record, moveId))
      const notes = [...imported.notes]
      if (git && git.snapshot.paths.length) {
        try {
          const reverted = revertMovedPaths({ root: git.location.root, head: git.snapshot.head, wip: git.snapshot.wip, paths: git.snapshot.paths })
          if (reverted.kept.length) notes.push(`Left in place here because they changed during the move: ${reverted.kept.join(", ")}`)
        } catch (error) {
          notes.push(`Its uncommitted files are still here as well (${error instanceof Error ? error.message : String(error)})`)
        }
      }
      if (git?.snapshot.leftBehind.length) notes.push(`${git.snapshot.leftBehind.length} uncommitted file(s) in the main checkout were not this thread's edits and stayed here`)
      if (git?.elsewhere.length) notes.push(`Its uncommitted edits outside ${git.location.rel === "." ? "the main checkout" : git.location.rel} stayed here: ${git.elsewhere.join(", ")}`)
      void ctx.board.rebuild().catch(() => {})
      audit("threadMoveOut", "ok", {
        project: auditProject, thread: slug,
        detail: { peer: peerRef(record), moveId, bytes: exported.bytes, compressed: exported.blob.length, files: exported.manifest.files.length, wipPaths: git?.snapshot.paths.length ?? 0, checkout: git?.location.rel ?? null },
      })
      return { peer: { id: record.id, name: record.name }, slug: imported.slug, notes }
    } catch (error) {
      const message = error instanceof UnconfirmedError
        ? `${error.message}. The thread may already be on ${record.name}: open it there, or retry the move — a retry is safe`
        : error instanceof Error ? error.message : String(error)
      audit("threadMoveOut", "refused", { project: auditProject, thread: slug, error: message, detail: { peer: peerRef(record), unconfirmed: error instanceof UnconfirmedError } })
      void ctx.board.rebuild().catch(() => {})
      throw new Error(message)
    } finally {
      moving.delete(moveKey)
      rmSync(workRoot, { recursive: true, force: true })
    }
  }

  function keepHere(ctx: AppContext, slug: string): void {
    const row = ctx.storage.getSession(slug)
    const stamp = movedStamp(row?.moved_to)
    if (!stamp?.pending) throw new Error("This thread has no unfinished move")
    ctx.storage.db.prepare("UPDATE session SET moved_to = NULL WHERE project_id = ? AND slug = ?").run(ctx.project.id, slug)
    audit("threadMoveOut", "refused", { project: { id: ctx.project.id, dir: workDirOf(ctx.project) }, thread: slug, error: "kept on this machine after an unconfirmed move", detail: { peer: { id: stamp.peerId, name: stamp.peerName }, moveId: stamp.moveId } })
    void ctx.board.rebuild().catch(() => {})
  }

  function blocked(projectId: string, row: Pick<SessionRow, "slug" | "moved_to"> | undefined): string | undefined {
    if (!row) return undefined
    const inFlight = moving.get(`${projectId}:${row.slug}`)
    if (inFlight) return `This thread is moving to ${inFlight}`
    return movedAwayBlock(row.moved_to)
  }

  // ---- the destination side ----

  async function onPrepare(peer: PeerRecord, args: { identities?: unknown; slug?: unknown; sessionId?: unknown; moveId?: unknown }): Promise<unknown> {
    const identities = Array.isArray(args.identities) ? args.identities.filter((id): id is string => typeof id === "string") : []
    const project = projectFor(identities)
    if (!project) throw new Error(`${name} has no copy of this project. Clone it there and add it to ntwine first`)
    const ctx = await deps.openProject(project.id)
    if (!ctx) throw new Error(`${name} could not open its copy of this project`)
    if (typeof args.slug !== "string" || typeof args.sessionId !== "string") throw new Error("malformed request")
    const standing = slugStanding(ctx.storage.db, ctx.project.id, args.slug, args.sessionId, typeof args.moveId === "string" ? args.moveId : undefined)
    if (standing === "taken") throw new Error(`${name} already has a different thread named @${args.slug} in ${project.name}`)
    return { project: project.name, dir: workDirOf(ctx.project), peer: peer.name }
  }

  async function onImport(peer: PeerRecord, args: { identities?: unknown; moveId?: unknown }, blob: Buffer): Promise<unknown> {
    const identities = Array.isArray(args.identities) ? args.identities.filter((id): id is string => typeof id === "string") : []
    const project = projectFor(identities)
    if (!project) throw new Error(`${name} has no copy of this project`)
    const ctx = await deps.openProject(project.id)
    if (!ctx) throw new Error(`${name} could not open its copy of this project`)
    const auditProject = { id: ctx.project.id, dir: workDirOf(ctx.project) }
    let slug: string | undefined
    try {
      let unpacked
      try {
        unpacked = unpackBundle(blob)
      } catch (error) {
        throw new Error(error instanceof BundleError ? error.message : "the thread's bundle could not be read")
      }
      const manifest = parseManifest(unpacked.manifest)
      if (!manifest || manifest.moveId !== args.moveId) throw new Error("the thread's bundle is malformed")
      slug = manifest.thread.slug
      if (manifest.thread.backend !== "claude") throw new Error("Only a Claude thread can move to another machine for now")
      const lock = `${ctx.project.id}:${slug}`
      if (importing.has(lock)) throw new Error("This thread is already arriving")
      importing.add(lock)
      try {
        const workDir = workDirOf(ctx.project)
        const result = importThread(
          { db: ctx.storage.db, project: { id: ctx.project.id, dir: ctx.project.dir, workDir, stateDir: ctx.project.stateDir }, home: deps.home, bucket: cwdSlug(workDir) },
          manifest,
          unpacked.files,
          { id: peer.id, name: peer.name },
          { name },
          (git) => restoreWip({ mainCheckout: workDir, ...git }),
        )
        if ("refused" in result) throw new Error(result.refused)
        ctx.board.refresh()
        void ctx.board.rebuild().catch(() => {})
        ctx.tailer.nudge?.()
        audit("threadMoveIn", "ok", {
          project: auditProject, thread: slug,
          detail: { peer: peerRef(peer), moveId: manifest.moveId, duplicate: result.duplicate, compressed: blob.length, files: unpacked.files.length, wipPaths: manifest.git?.paths.length ?? 0, checkout: manifest.git?.rel ?? null },
        })
        return { slug: result.slug, notes: result.notes }
      } finally {
        importing.delete(lock)
      }
    } catch (error) {
      audit("threadMoveIn", "refused", { project: auditProject, ...(slug ? { thread: slug } : {}), error: error instanceof Error ? error.message : String(error), detail: { peer: peerRef(peer), compressed: blob.length } })
      throw error
    }
  }

  // ---- inbound ----

  async function handleCall(request: Request): Promise<Response> {
    const body = await readBody(request, MAX_CALL_BYTES)
    if (!body) return plain(413, "too large")
    const senderKey = requestSender(body)
    const sender = senderKey ? store.byPublicKey(senderKey) : undefined
    let opened
    try {
      opened = openRequest(key, body, () => sender !== undefined)
    } catch (error) {
      if (senderKey && !sender) return plain(403, "this machine is not paired with the sender")
      return plain(403, error instanceof PeerCryptoError ? error.message : "refused")
    }
    const peer = sender!
    const reply = (head: unknown) => new Response(new Uint8Array(opened.sealResponse(frameMessage(head))), { status: 200, headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } })
    let message: { op?: unknown; id?: unknown; ts?: unknown; args?: unknown }
    let blob: Buffer
    try {
      const framed = unframeMessage(opened.plaintext)
      message = framed.head as typeof message
      blob = framed.blob
    } catch {
      return reply({ ok: false, error: "malformed request" })
    }
    const now = Date.now()
    for (const [id, until] of seen) if (until < now) seen.delete(id)
    if (typeof message.ts !== "number" || Math.abs(now - message.ts) > REPLAY_WINDOW_MS) {
      return reply({ ok: false, error: `the two machines' clocks disagree by more than ${REPLAY_WINDOW_MS / 60_000}m` })
    }
    if (typeof message.id !== "string" || seen.has(message.id)) return reply({ ok: false, error: "replayed request" })
    seen.set(message.id, now + REPLAY_WINDOW_MS * 2)
    store.update(peer.id, { lastSeenAt: new Date(now).toISOString() })
    const args = (message.args && typeof message.args === "object" ? message.args : {}) as Record<string, unknown>
    try {
      switch (message.op) {
        case "ping":
          return reply({ ok: true, result: { name, protocol: PROTOCOL } })
        case "prepare":
          return reply({ ok: true, result: await onPrepare(peer, args) })
        case "import":
          return reply({ ok: true, result: await onImport(peer, args, blob) })
        case "unpair":
          store.remove(peer.id)
          audit("peerUnpair", "ok", { detail: { peer: peerRef(peer), by: "peer" } })
          return reply({ ok: true, result: {} })
        default:
          return reply({ ok: false, error: `${name}'s ntwine does not understand this request; update it` })
      }
    } catch (error) {
      return reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  interface Hello { v: 1; name: string; publicKey: string; nonce: string; addresses: string[] }

  function parseHello(text: unknown): Hello | undefined {
    if (typeof text !== "string" || text.length > 8_000) return undefined
    try {
      const hello = JSON.parse(text) as Partial<Hello>
      if (hello.v !== 1 || typeof hello.name !== "string" || typeof hello.publicKey !== "string" || typeof hello.nonce !== "string" || !Array.isArray(hello.addresses)) return undefined
      publicKeyObject(Buffer.from(hello.publicKey, "base64url"))
      return { v: 1, name: hello.name.slice(0, 80), publicKey: hello.publicKey, nonce: hello.nonce, addresses: hello.addresses.filter((a): a is string => typeof a === "string").slice(0, 8) }
    } catch {
      return undefined
    }
  }

  async function handlePair(request: Request): Promise<Response> {
    const body = await readBody(request, MAX_PAIR_BYTES)
    if (!body) return plain(413, "too large")
    let parsed: { hello?: unknown; mac?: unknown }
    try {
      parsed = JSON.parse(body.toString("utf8"))
    } catch {
      return plain(400, "malformed")
    }
    const hello = parseHello(parsed.hello)
    if (!hello || typeof parsed.mac !== "string") return plain(400, "malformed")
    const live = codes.live()
    if (!live.length) return plain(403, `${name} is not showing a pairing code. Show one in Settings → Other machines`)
    const code = live.find((candidate) => macsMatch(pairMac(candidate, "request", parsed.hello as string), parsed.mac as string))
    if (!code || !codes.consume(code)) {
      codes.fail()
      audit("peerPair", "refused", { error: "wrong pairing code", detail: { claimedName: hello.name } })
      return plain(403, "That code does not match the one this machine is showing")
    }
    if (Buffer.from(hello.publicKey, "base64url").equals(key.publicKey)) return plain(403, "A machine cannot pair with itself")
    let url = ""
    for (const address of hello.addresses) {
      try {
        url = normalizeUrl(address)
        break
      } catch { /* next */ }
    }
    const record = store.upsert({ name: hello.name, url, publicKey: hello.publicKey, pairedAt: new Date().toISOString() })
    const welcome = JSON.stringify({ v: 1, name, publicKey: key.publicKey.toString("base64url"), nonce: randomBytes(16).toString("hex"), addresses: selfAddresses(store.listener(), name) } satisfies Hello)
    audit("peerPair", "ok", { detail: { peer: peerRef(record), role: "showed-code", address: url || null } })
    return new Response(JSON.stringify({ welcome, mac: pairMac(code, "response", parsed.hello as string, welcome) }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } })
  }

  async function handle(request: Request, origin: RequestOrigin): Promise<Response> {
    if (request.method !== "POST") return plain(405, "method not allowed")
    const path = new URL(request.url).pathname
    // Attributed like any request, so each audit line says which way it came in.
    return withRequestOrigin(origin, async () => {
      if (path === `${PEER_ROUTE_PREFIX}pair`) return handlePair(request)
      if (path === `${PEER_ROUTE_PREFIX}call`) return handleCall(request)
      return plain(404, "not found")
    })
  }

  // ---- the network listener ----

  async function startListener(port: number): Promise<void> {
    await stopListener()
    const server = createServer((req, res) => void serveNode(req, res))
    await new Promise<void>((done) => {
      server.once("error", (error) => {
        listenerError = `Could not listen on port ${port}: ${(error as NodeJS.ErrnoException).code ?? error.message}`
        log.warn("peer", listenerError)
        done()
      })
      server.listen(port, () => {
        listenerError = undefined
        listener = { server, port }
        log.info("peer", `listening for other machines on port ${port}`)
        done()
      })
    })
  }

  async function stopListener(): Promise<void> {
    const current = listener
    listener = undefined
    if (current) await new Promise<void>((done) => current.server.close(() => done()))
  }

  async function serveNode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ONLY the peer routes: the listener exists so another machine can reach this one without the board
    // ever being exposed. Everything else is a 404 from a server that has nothing else.
    const url = req.url ?? "/"
    if (!url.startsWith(PEER_ROUTE_PREFIX) || req.method !== "POST") {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("not found")
      return
    }
    try {
      const request = new Request(`http://peer${url}`, {
        method: "POST",
        headers: Object.entries(req.headers).flatMap(([name, value]) => (typeof value === "string" ? [[name, value] as [string, string]] : [])),
        body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
        duplex: "half",
      } as RequestInit & { duplex: "half" })
      const device = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 80) : "ntwine"
      const response = await handle(request, { via: "network", remote: req.socket.remoteAddress ?? null, session: null, device })
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" })
      res.end(error instanceof Error ? error.message : "error")
    }
  }

  const saved = store.listener()
  if (deps.startListener !== false && saved.enabled) void startListener(saved.port)

  return {
    state: () => {
      const config = store.listener()
      return {
        self: { name, id: selfId, fingerprint: peerFingerprint(selfId), addresses: selfAddresses(config, name) },
        listener: { enabled: config.enabled, port: config.port, ...(config.enabled && listenerError ? { error: listenerError } : {}) },
        peers: store.list().map(peerView),
      }
    },
    mintPairCode: () => {
      const minted = codes.mint()
      return { code: minted.code, expiresAt: new Date(minted.expiresAt).toISOString(), addresses: selfAddresses(store.listener(), name) }
    },
    join: async (rawUrl, typedCode) => {
      const url = normalizeUrl(rawUrl)
      const code = normalizePairCode(typedCode)
      if (!code) throw new Error("A pairing code is 12 letters and digits, like 7K3M-9QWT-X2PB")
      const hello = JSON.stringify({ v: 1, name, publicKey: key.publicKey.toString("base64url"), nonce: randomBytes(16).toString("hex"), addresses: selfAddresses(store.listener(), name) } satisfies Hello)
      let response: Response
      try {
        response = await fetchImpl(`${url}${PEER_ROUTE_PREFIX}pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hello, mac: pairMac(code, "request", hello) }),
          signal: AbortSignal.timeout(15_000),
        })
      } catch (error) {
        throw new Error(`Nothing answered at ${url} (${error instanceof Error ? error.message : String(error)})`)
      }
      const text = await response.text()
      if (response.status !== 200) {
        audit("peerPair", "refused", { error: text.slice(0, 200), detail: { address: url, role: "entered-code" } })
        throw new Error(text.slice(0, 300) || `${url} answered ${response.status}`)
      }
      let parsed: { welcome?: unknown; mac?: unknown }
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(`${url} did not answer like ntwine`)
      }
      const welcome = parseHello(parsed.welcome)
      // The answer must carry the same code over BOTH messages: only the machine showing it can make it.
      if (!welcome || typeof parsed.mac !== "string" || !macsMatch(pairMac(code, "response", hello, parsed.welcome as string), parsed.mac)) {
        audit("peerPair", "refused", { error: "the other machine's answer did not match the code", detail: { address: url, role: "entered-code" } })
        throw new Error(`The machine at ${url} could not prove it showed that code`)
      }
      const record = store.upsert({ name: welcome.name, url, publicKey: welcome.publicKey, pairedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
      audit("peerPair", "ok", { detail: { peer: peerRef(record), role: "entered-code", address: url } })
      return peerView(record)
    },
    unpair: async (id) => {
      const record = store.get(id)
      if (!record) return
      // Tell the other machine, best effort: either way this one forgets it.
      if (record.url) await call(record, "unpair", {}, { timeoutMs: 5_000 }).catch(() => {})
      store.remove(id)
      audit("peerUnpair", "ok", { detail: { peer: peerRef(record), by: "this machine" } })
    },
    setAddress: (id, url) => {
      const record = store.update(id, { url: normalizeUrl(url), lastError: undefined })
      if (!record) throw new Error("That machine is not paired with this one")
      return peerView(record)
    },
    setListener: async (enabled, port) => {
      const config = { enabled, port: port ?? store.listener().port ?? DEFAULT_PEER_PORT }
      store.setListener(config)
      if (enabled) await startListener(config.port)
      else {
        listenerError = undefined
        await stopListener()
      }
      return { enabled, port: config.port, ...(enabled && listenerError ? { error: listenerError } : {}) }
    },
    ping: async (id) => {
      const record = requirePeer(id)
      const started = performance.now()
      const result = await call(record, "ping", {}, { timeoutMs: 10_000 }) as { name?: string }
      if (typeof result?.name === "string" && result.name !== record.name) store.update(id, { name: result.name })
      return { name: typeof result?.name === "string" ? result.name : record.name, ms: Math.round(performance.now() - started) }
    },
    preview,
    move,
    keepHere,
    blocked,
    handle,
    close: stopListener,
  }
}
