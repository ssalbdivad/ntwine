import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { randomUUID } from "node:crypto"
import { ThreadSlug, type ThreadMoveStamp } from "@ntwine/shared"
import type Database from "./sqlite.ts"
import { BUNDLE_MAX_BYTES, packBundle, safeRelativePath, type BundleFile, type BundleRoot } from "./thread-bundle.ts"
import { mapPrefix, relocateJsonl, relocateRecord, type PrefixMap, type RelocationRules } from "./transcript-relocate.ts"

// A THREAD'S STATE, OUT OF ONE MACHINE AND INTO ANOTHER (plans/thread-handoff.md §§ 1, 2, 5).
//
// No network and no crypto here — this is the data half: which rows and files make up a thread, how
// they are packed, and how the destination checks and places them. peer-service.ts carries the result
// between machines; thread-wip.ts does the git half. Every table and file below was read off the code
// on 2026-11-12, and the plan's tables say why each one moves or stays.

/** The tables a move carries, and the column that names the thread in each. */
const MOVED_TABLES: readonly { table: string; slugColumns: readonly string[] }[] = [
  { table: "session", slugColumns: ["slug"] },
  { table: "thread_question", slugColumns: ["thread_slug"] },
  { table: "thread_done", slugColumns: ["thread_slug"] },
  { table: "thread_link", slugColumns: ["thread_slug"] },
  { table: "thread_reaction", slugColumns: ["thread_slug"] },
  { table: "subagent_steer", slugColumns: ["thread_slug"] },
  { table: "retired_op", slugColumns: ["slug"] },
  { table: "thread_timer", slugColumns: ["thread_slug"] },
  { table: "pr_watch", slugColumns: ["thread_slug"] },
  { table: "command_watch", slugColumns: ["thread_slug"] },
  { table: "thread_spinoff", slugColumns: ["parent_slug", "child_slug"] },
]

/** Live-only directories in a Claude session dir: a mailbox and deadline marks for running sub-agents. */
const SESSION_DIR_SKIP = new Set(["ntwine-inbox", "ntwine-deadlines"])
/** The scratch directory is the worker's notes, not a dumping ground; a move refuses past this. */
export const SCRATCH_MAX_BYTES = 200 * 1024 * 1024
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const ATTACHMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/

export interface MoveGit {
  /** "." for the main checkout, ".ntwine/worktrees/<name>" for a worktree. */
  rel: string
  branch: string | null
  head: string
  wip: string
  paths: string[]
}

export interface MoveManifest {
  v: 1
  moveId: string
  createdAt: string
  from: { home: string; platform: string }
  project: { name: string; workDir: string; stateDir: string; bucket: string }
  thread: { slug: string; sessionId: string; transcriptIds: string[]; backend: string }
  rows: Record<string, Record<string, unknown>[]>
  git: MoveGit | null
  files: BundleFile[]
}

export interface ExportInput {
  db: Database
  project: { id: string; name: string; dir: string; workDir: string; stateDir: string }
  /** The Claude bucket the transcript lives in: `cwdSlug(workDir)`, or the sibling it drifted to. */
  bucket: string
  slug: string
  home: string
  moveId: string
  git?: (MoveGit & { bundle: Buffer }) | null
}

export interface ExportedThread {
  manifest: MoveManifest
  blob: Buffer
  /** Uncompressed size, for the preview. */
  bytes: number
}

export class MoveRefusal extends Error {}

function rowsOf(db: Database, projectId: string, slug: string): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {}
  for (const { table, slugColumns } of MOVED_TABLES) {
    const where = slugColumns.map((column) => `${column} = @slug`).join(" OR ")
    const rows = db.prepare<Record<string, string>, Record<string, unknown>>(`SELECT * FROM ${table} WHERE project_id = @project AND (${where})`).all({ project: projectId, slug })
    out[table] = rows
      // A spinoff to ANOTHER project names a project the destination may not have; it would dangle.
      .filter((row) => table !== "thread_spinoff" || row.child_project_id == null || row.child_project_id === projectId)
      .map(({ project_id: _project, ...rest }) => (table === "thread_spinoff" && rest.child_project_id === projectId ? { ...rest, child_project_id: null } : rest))
  }
  return out
}

/** Every file under `dir`, as `/`-separated paths relative to it. Symlinks are not followed or carried. */
function walkFiles(dir: string, skipTop: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = []
  const visit = (current: string, top: boolean) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (top && skipTop.has(entry.name)) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path, false)
      else if (entry.isFile()) out.push(relative(dir, path).split(sep).join("/"))
    }
  }
  visit(dir, true)
  return out.sort()
}

/** The session ids whose transcript files belong to this thread: the pinned one and a drifted one. */
export function transcriptIdsOf(row: { session_id: string; transcript_id?: string | null }): string[] {
  return [...new Set([row.session_id, row.transcript_id].filter((id): id is string => !!id && SESSION_ID.test(id)))]
}

export function exportThread(input: ExportInput): ExportedThread {
  const rows = rowsOf(input.db, input.project.id, input.slug)
  const session = rows.session?.[0]
  if (!session) throw new MoveRefusal("This thread has no record to move")
  const sessionId = String(session.session_id)
  const transcriptIds = transcriptIdsOf({ session_id: sessionId, transcript_id: session.transcript_id as string | null })
  const files: BundleFile[] = []
  const contents: Buffer[] = []
  const add = (root: BundleRoot, rel: string, path: string) => {
    const data = readFileSync(path)
    const mode = statSync(path).mode & 0o777
    files.push({ root, rel, size: data.length, mode })
    contents.push(data)
  }

  // The transcript and its session directory, under the Claude bucket.
  const bucketDir = join(input.home, ".claude", "projects", input.bucket)
  let transcriptText = ""
  for (const id of transcriptIds) {
    const transcript = join(bucketDir, `${id}.jsonl`)
    if (existsSync(transcript)) {
      add("claude", `${id}.jsonl`, transcript)
      transcriptText += contents[contents.length - 1]!.toString("utf8")
    }
    const sessionDir = join(bucketDir, id)
    for (const rel of walkFiles(sessionDir, SESSION_DIR_SKIP)) add("claude", `${id}/${rel}`, join(sessionDir, rel))
  }
  if (!transcriptIds.some((id) => files.some((file) => file.root === "claude" && file.rel === `${id}.jsonl`))) {
    throw new MoveRefusal("This thread's transcript was not found on this machine")
  }

  // The worker's scratch notes.
  const scratchDir = join(input.project.dir, ".ntwine", "threads", sessionId)
  let scratchBytes = 0
  for (const rel of walkFiles(scratchDir)) {
    scratchBytes += statSync(join(scratchDir, rel)).size
    if (scratchBytes > SCRATCH_MAX_BYTES) throw new MoveRefusal(`This thread's notes folder (.ntwine/threads/${sessionId}) is over ${SCRATCH_MAX_BYTES / 1024 / 1024} MB; clear it out first`)
    add("scratch", rel, join(scratchDir, rel))
  }

  // Attachments the transcript cites. They live per project and are cited by absolute path.
  const attachmentsDir = join(input.project.stateDir, "attachments")
  const cited = new Set<string>()
  const prefix = `${attachmentsDir}/`
  for (let at = transcriptText.indexOf(prefix); at >= 0; at = transcriptText.indexOf(prefix, at + prefix.length)) {
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(transcriptText.slice(at + prefix.length))?.[0]
    if (name && ATTACHMENT_NAME.test(name)) cited.add(name)
  }
  for (const name of [...cited].sort()) {
    const path = join(attachmentsDir, name)
    if (existsSync(path)) add("attachments", name, path)
  }

  let git: MoveGit | null = null
  if (input.git) {
    const { bundle, ...meta } = input.git
    git = meta
    files.push({ root: "git", rel: "wip.bundle", size: bundle.length, mode: 0o644 })
    contents.push(bundle)
  }

  const manifest: MoveManifest = {
    v: 1,
    moveId: input.moveId,
    createdAt: new Date().toISOString(),
    from: { home: input.home, platform: process.platform },
    project: { name: input.project.name, workDir: input.project.workDir, stateDir: input.project.stateDir, bucket: input.bucket },
    thread: { slug: input.slug, sessionId, transcriptIds, backend: String(session.backend ?? "claude") },
    rows,
    git,
    files,
  }
  const bytes = contents.reduce((sum, data) => sum + data.length, 0)
  if (bytes > BUNDLE_MAX_BYTES) throw new MoveRefusal("This thread is too large to move")
  return { manifest, blob: packBundle(manifest, contents), bytes }
}

// ---- the destination ----

export interface ImportTarget {
  db: Database
  /** The destination's project: `dir` holds the board (and the scratch notes), `workDir` is the checkout. */
  project: { id: string; dir: string; workDir: string; stateDir: string }
  home: string
  /** `cwdSlug(project.workDir)` on this machine. */
  bucket: string
}

export interface ImportPeer {
  id: string
  name: string
}

/** The git half, injected so this module stays free of git (thread-wip.ts restoreWip). */
export type RestoreGit = (input: MoveGit & { bundleFile: string; slug: string }) => { ok: true } | { refused: string }

export type ImportResult =
  | { ok: true; slug: string; duplicate: boolean; notes: string[] }
  | { refused: string }

/** Shape-check a manifest that arrived from another machine. Undefined means it is unusable. */
export function parseManifest(value: Record<string, unknown>): MoveManifest | undefined {
  const m = value as Partial<MoveManifest>
  const str = (v: unknown): v is string => typeof v === "string"
  if (m.v !== 1 || !str(m.moveId) || !/^[A-Za-z0-9-]{8,64}$/.test(m.moveId) || !str(m.createdAt)) return undefined
  if (!m.from || !str(m.from.home) || !str(m.from.platform)) return undefined
  if (!m.project || !str(m.project.name) || !str(m.project.workDir) || !str(m.project.stateDir) || !str(m.project.bucket)) return undefined
  if (!m.thread || !ThreadSlug.safeParse(m.thread.slug).success || !str(m.thread.sessionId) || !SESSION_ID.test(m.thread.sessionId)) return undefined
  if (!Array.isArray(m.thread.transcriptIds) || !m.thread.transcriptIds.every((id) => str(id) && SESSION_ID.test(id))) return undefined
  if (!m.thread.transcriptIds.includes(m.thread.sessionId) || !str(m.thread.backend)) return undefined
  if (!m.rows || typeof m.rows !== "object" || !Array.isArray(m.rows.session) || m.rows.session.length !== 1) return undefined
  const session = m.rows.session[0]!
  if (session.slug !== m.thread.slug || session.session_id !== m.thread.sessionId) return undefined
  if (m.git !== null) {
    const g = m.git
    if (!g || !str(g.rel) || !(g.rel === "." || /^\.ntwine\/worktrees\/[^/]+$/.test(g.rel)) || !(g.branch === null || str(g.branch))) return undefined
    if (!str(g.head) || !/^[0-9a-f]{40,64}$/.test(g.head) || !str(g.wip) || !/^[0-9a-f]{40,64}$/.test(g.wip)) return undefined
    if (!Array.isArray(g.paths) || !g.paths.every((path) => str(path) && safeRelativePath(path))) return undefined
  }
  return m as MoveManifest
}

function columnsOf(db: Database, table: string): Set<string> {
  return new Set(db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((column) => column.name))
}

function readStamp(raw: unknown): (ThreadMoveStamp & Record<string, unknown>) | undefined {
  if (typeof raw !== "string" || !raw) return undefined
  try {
    const parsed = JSON.parse(raw) as ThreadMoveStamp & Record<string, unknown>
    return typeof parsed.moveId === "string" ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Is the slug free on this machine for this thread? A moved-away stub of the same session is a thread
 * coming home, and a row this exact move already wrote is a retry.
 */
export function slugStanding(db: Database, projectId: string, slug: string, sessionId: string, moveId?: string): "free" | "home" | "duplicate" | "taken" {
  const row = db.prepare<[string, string], Record<string, unknown>>("SELECT * FROM session WHERE project_id = ? AND slug = ?").get(projectId, slug)
  if (!row) return "free"
  if (moveId && readStamp(row.moved_from)?.moveId === moveId) return "duplicate"
  if (readStamp(row.moved_to) && row.session_id === sessionId) return "home"
  return "taken"
}

function writeFile(path: string, data: Buffer | string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data, { mode })
}

/** The one-time note the worker reads in its first message on this machine. */
export function movedNote(fromName: string, toName: string, maps: readonly PrefixMap[]): string {
  const moved = maps.filter((map) => map.from !== map.to).map((map) => `\`${map.from}\` is now \`${map.to}\``)
  return [
    `⟦ntwine⟧ This thread moved from ${fromName} to ${toName}.`,
    moved.length ? `Paths in the conversation above are ${fromName}'s: ${moved.join("; ")}.` : "",
    "Nothing it had running came along: background shells, sub-agents, dev servers and timers that were not registered with ntwine are gone. Its uncommitted work and notes are here.",
  ].filter(Boolean).join(" ")
}

export function importThread(target: ImportTarget, manifest: MoveManifest, files: readonly { file: BundleFile; data: Buffer }[], peer: ImportPeer, self: { name: string }, restoreGit: RestoreGit | undefined): ImportResult {
  const { slug, sessionId, transcriptIds } = manifest.thread
  const standing = slugStanding(target.db, target.project.id, slug, sessionId, manifest.moveId)
  if (standing === "duplicate") return { ok: true, slug, duplicate: true, notes: [] }
  if (standing === "taken") return { refused: `This machine already has a different thread named @${slug} in this project` }

  // Every file must land inside the root it names, and the claude files must belong to this session.
  for (const { file } of files) {
    if (file.root === "claude" && !transcriptIds.some((id) => file.rel === `${id}.jsonl` || file.rel.startsWith(`${id}/`))) {
      return { refused: "The thread's bundle carries a transcript file that is not its own" }
    }
    if (file.root === "attachments" && !ATTACHMENT_NAME.test(file.rel)) return { refused: "The thread's bundle carries an attachment it cannot place" }
    if (file.root === "git" && file.rel !== "wip.bundle") return { refused: "The thread's bundle carries an unexpected git file" }
  }
  const gitFile = files.find(({ file }) => file.root === "git")
  if (!!manifest.git !== !!gitFile) return { refused: "The thread's bundle and its git record disagree" }

  const cwdMaps: PrefixMap[] = [
    { from: manifest.project.workDir, to: target.project.workDir },
    { from: manifest.from.home, to: target.home },
  ]
  const rules: RelocationRules = {
    cwd: cwdMaps,
    refs: [
      ...transcriptIds.map((id) => ({
        from: join(manifest.from.home, ".claude", "projects", manifest.project.bucket, id),
        to: join(target.home, ".claude", "projects", target.bucket, id),
      })),
      { from: `${manifest.project.stateDir}/attachments/`, to: `${join(target.project.stateDir, "attachments")}/` },
    ],
  }

  // GIT FIRST: it is the one step that can refuse on what this machine holds, and it writes nothing
  // until all of its own checks pass. Nothing below runs unless it did.
  const notes: string[] = []
  if (manifest.git && gitFile) {
    if (!restoreGit) return { refused: "This machine cannot restore the thread's checkout" }
    const scratch = join(tmpdir(), `ntwine-move-${randomUUID()}.bundle`)
    try {
      writeFileSync(scratch, gitFile.data, { mode: 0o600 })
      const restored = restoreGit({ ...manifest.git, bundleFile: scratch, slug })
      if ("refused" in restored) return restored
    } finally {
      rmSync(scratch, { force: true })
    }
  }

  // Files. The thread's own session dir and scratch dir are replaced whole: on a thread coming home they
  // hold the copy it left with, which the bundle supersedes.
  const bucketDir = join(target.home, ".claude", "projects", target.bucket)
  const scratchDir = join(target.project.dir, ".ntwine", "threads", sessionId)
  for (const id of transcriptIds) rmSync(join(bucketDir, id), { recursive: true, force: true })
  rmSync(scratchDir, { recursive: true, force: true })
  for (const { file, data } of files) {
    if (file.root === "claude") {
      const text = file.rel.endsWith(".jsonl") ? relocateJsonl(data.toString("utf8"), rules)
        : file.rel.endsWith(".json") ? relocateRecord(data.toString("utf8"), rules)
          : undefined
      writeFile(join(bucketDir, file.rel), text ?? data, file.mode | 0o600)
    } else if (file.root === "scratch") {
      writeFile(join(scratchDir, file.rel), data, file.mode | 0o600)
    } else if (file.root === "attachments") {
      const path = join(target.project.stateDir, "attachments", file.rel)
      if (!existsSync(path)) writeFile(path, data, 0o600)
    }
  }

  // Rows, in one transaction: the stub (if this is a thread coming home) goes, the moved rows come in.
  const stamp: ThreadMoveStamp & { note: string } = {
    peerId: peer.id,
    peerName: peer.name,
    at: new Date().toISOString(),
    moveId: manifest.moveId,
    note: movedNote(peer.name, self.name, cwdMaps),
  }
  const insert = target.db.transaction(() => {
    for (const { table, slugColumns } of MOVED_TABLES) {
      const where = slugColumns.map((column) => `${column} = @slug`).join(" OR ")
      target.db.prepare(`DELETE FROM ${table} WHERE project_id = @project AND (${where})`).run({ project: target.project.id, slug })
    }
    // A cache keyed by the old path, and wakes queued for the stub: neither is this thread's any more.
    target.db.prepare("DELETE FROM tail_state WHERE project_id = ? AND slug = ?").run(target.project.id, slug)
    target.db.prepare("UPDATE wake_delivery SET state = 'superseded', lease_owner = NULL, lease_until = NULL WHERE project_id = ? AND thread_slug = ? AND state IN ('pending', 'leased')").run(target.project.id, slug)
    for (const { table } of MOVED_TABLES) {
      const columns = columnsOf(target.db, table)
      for (const source of manifest.rows[table] ?? []) {
        const row: Record<string, unknown> = { ...source, project_id: target.project.id }
        if (table === "session") {
          row.moved_to = null
          row.moved_from = JSON.stringify(stamp)
          // The schedule stays on the machine that has it; a run that moved is just a thread here.
          row.schedule_id = null
        }
        if (table === "thread_link" && row.kind === "file" && typeof row.target === "string") row.target = mapPrefix(row.target, cwdMaps)
        // Columns this machine's schema does not have (a newer origin) are dropped; columns it has that the
        // origin did not send take their defaults.
        const names = Object.keys(row).filter((name) => columns.has(name))
        const values = names.map((name) => {
          const value = row[name]
          return value === undefined ? null : value
        })
        target.db.prepare(`INSERT OR REPLACE INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...values)
      }
    }
  })
  insert.immediate()
  if (!manifest.git) notes.push("Its checkout did not move: it had no uncommitted work in this project's repository")
  return { ok: true, slug, duplicate: false, notes }
}

// ---- the origin, once the destination has it ----

/**
 * Turn the thread into a read-only stub that names where it went, and settle every wait it had armed
 * here, so a timer or a PR watch fires on exactly one machine. One transaction.
 */
export function markMovedAway(db: Database, projectId: string, slug: string, stamp: ThreadMoveStamp): void {
  const now = Date.now()
  db.transaction(() => {
    db.prepare(`UPDATE session SET moved_to = ?, state = 'archived', snoozed_until = NULL, snooze_prompt = NULL,
      recurring_on_rest = 0, recurring_on_schedule = 0, recurring_on_compact = 0
      WHERE project_id = ? AND slug = ?`).run(JSON.stringify(stamp), projectId, slug)
    db.prepare("UPDATE thread_timer SET state = 'cancelled', settled_at = ? WHERE project_id = ? AND thread_slug = ? AND state = 'armed'").run(now, projectId, slug)
    db.prepare("UPDATE pr_watch SET state = 'dropped', settled_at = ? WHERE project_id = ? AND thread_slug = ? AND state = 'armed'").run(now, projectId, slug)
    db.prepare("UPDATE command_watch SET state = 'cancelled', settled_at = ? WHERE project_id = ? AND thread_slug = ? AND state = 'armed'").run(now, projectId, slug)
    db.prepare("UPDATE thread_watch SET state = 'dropped', settled_at = ? WHERE project_id = ? AND thread_slug = ? AND state = 'armed'").run(now, projectId, slug)
    db.prepare("UPDATE wake_delivery SET state = 'superseded', lease_owner = NULL, lease_until = NULL WHERE project_id = ? AND thread_slug = ? AND state IN ('pending', 'leased')").run(projectId, slug)
  }).immediate()
}

/** Wakes still on their way to this thread's worker. A move would drop them, so it waits instead. */
export function pendingWakes(db: Database, projectId: string, slug: string): number {
  return db.prepare<[string, string], { n: number }>("SELECT COUNT(*) AS n FROM wake_delivery WHERE project_id = ? AND thread_slug = ? AND state IN ('pending', 'leased')").get(projectId, slug)?.n ?? 0
}

export function movedStamp(raw: unknown): ThreadMoveStamp | undefined {
  const stamp = readStamp(raw)
  if (!stamp || typeof stamp.peerId !== "string" || typeof stamp.peerName !== "string" || typeof stamp.at !== "string") return undefined
  return { peerId: stamp.peerId, peerName: stamp.peerName, at: stamp.at, moveId: stamp.moveId }
}

/** The arrival note, if the worker has not been told yet. */
export function untoldMoveNote(raw: unknown): string | undefined {
  const stamp = readStamp(raw)
  return stamp && typeof stamp.note === "string" && !stamp.noteToldAt ? stamp.note : undefined
}

export function markMoveNoteTold(db: Database, projectId: string, slug: string): void {
  const row = db.prepare<[string, string], { moved_from: string | null }>("SELECT moved_from FROM session WHERE project_id = ? AND slug = ?").get(projectId, slug)
  const stamp = readStamp(row?.moved_from)
  if (!stamp) return
  db.prepare("UPDATE session SET moved_from = ? WHERE project_id = ? AND slug = ?").run(JSON.stringify({ ...stamp, noteToldAt: new Date().toISOString() }), projectId, slug)
}
