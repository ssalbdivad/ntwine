import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ---- Antigravity (`agy`) native swarm tracking ----
// An agy thread can run parallel workers through agy's own `swarm` tool (`swarm{action:"add", name,
// brief}`): each worker is a full agy conversation of its own, sometimes in its own worktree under
// `~/.gemini/antigravity-cli/worktrees/<conv>/swarm-<name>-<hash>`. None of that crosses the ACP pipe
// ntwine drives the thread over — the coordinator's `swarm` calls arrive as opaque tool calls — so the
// board showed none of the workers and `ntwinectl activity` listed none. This module is the agy
// counterpart of codex-subagents.ts: it reads agy's own on-disk swarm state and publishes each member
// into the SAME live/retired maps a Claude or codex sub-agent fills, through a narrow sink.
//
// WHERE AGY KEEPS IT (agy 1.5.11, read off the shipped swarm-board sidecar's own docs and code):
//   <home>/brain/<coordinatorConv>/.system_generated/swarm/members.json — the roster:
//     {"title", "members": {<name>: {conversation_id, role, model, applied_model, phase, desired_state,
//      killed, wake_mode, wait_since, last_read_seq, …}}}
//   <home>/brain/<memberConv>/.system_generated/logs/transcript.jsonl — each member's compact transcript,
//     one step per line: {step_index, source, type, status, created_at, content, tool_calls, …}
// The swarm dir lives under the COORDINATOR's conversation, and an ntwine agy thread's
// `agent_session_id` is exactly that conversation id (the ACP session id agy hands back IS its
// conversation id — checked against a live 49-member swarm). So the join is a path, not a search.
//
// STATE follows agy's own `manage_swarm status` reading (`board.StateOf`, mirrored by the sidecar's
// `statusOf`): `killed` when the roster says so; `waiting` when the member's run has stopped; else
// `working`. "Has the run stopped" is judged from the newest transcript steps (`agyTurnEnded`, a port of
// the sidecar's `turnEnded`), NOT from `wake_mode`: a member parked in `swarm_wait` and woken by a
// background task stays `mentions` while it works. `stopped` is agy's fourth state; the roster's own
// `phase` is the only field that can carry it, so any phase other than RUNNING/KILLED reads as stopped.
//
// HOW IT MAPS ONTO NTWINE: `working` is a RUNNING sub-agent (it holds the thread exactly as a Claude
// child does); `waiting` and `stopped` are live rows that hold nothing back (a swarm whose every member
// waits while the coordinator rests is stalled, and that thread belongs in the queue); `killed` retires
// the row into the finished ring with outcome `killed` — agy has no separate "completed": a coordinator
// kills a helper "when its work is done", so kill IS the ordinary end, and the outcome says what agy said.

export type AgySwarmState = "working" | "waiting" | "stopped" | "killed" | "completed"
export type AgySwarmLiveState = Exclude<AgySwarmState, "killed" | "completed">

export function defaultAgyHome(): string {
  return join(homedir(), ".gemini", "antigravity-cli")
}

export function agySwarmRosterPath(home: string, coordinatorConv: string): string {
  return join(home, "brain", coordinatorConv, ".system_generated", "swarm", "members.json")
}

export function agySubAgentsDir(home: string, parentConv: string): string {
  return join(home, "brain", parentConv, ".system_generated", "subagents")
}

export function agyTranscriptPath(home: string, conv: string): string {
  return join(home, "brain", conv, ".system_generated", "logs", "transcript.jsonl")
}

// The drill-in / correlation id of one member. Its conversation id is the stable identity (a name can be
// reused after a kill; a conversation cannot), prefixed so it can never collide with a tool_use id.
export function agySwarmMemberId(conv: string): string {
  return `agy-swarm:${conv}`
}

export function isAgySwarmMemberId(id: string | undefined): boolean {
  return !!id && id.startsWith("agy-swarm:")
}

export function agySubAgentId(conv: string): string {
  return `agy-subagent:${conv}`
}

export function isAgySubAgentId(id: string | undefined): boolean {
  return !!id && id.startsWith("agy-subagent:")
}

type AgySubAgentRecord = {
  conversationId: string
  typeName?: string
  role?: string
  state?: string
}

export function parseAgySubAgent(text: string): AgySubAgentRecord | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as { conversationId?: unknown; subagentDescriptor?: unknown; state?: unknown }
  const conversationId = str(obj.conversationId)
  if (!conversationId) return undefined
  const desc = obj.subagentDescriptor && typeof obj.subagentDescriptor === "object"
    ? (obj.subagentDescriptor as { typeName?: unknown; role?: unknown })
    : undefined
  const typeName = str(desc?.typeName)
  const role = str(desc?.role)
  const state = str(obj.state)
  return { conversationId, ...(typeName ? { typeName } : {}), ...(role ? { role } : {}), ...(state ? { state } : {}) }
}

type RosterMember = {
  conversation_id?: unknown
  role?: unknown
  model?: unknown
  applied_model?: unknown
  desired_model?: unknown
  phase?: unknown
  desired_state?: unknown
  killed?: unknown
  wake_mode?: unknown
}

export type AgyRoster = { title?: string; members: [name: string, member: RosterMember][] }

export function parseAgyRoster(text: string): AgyRoster | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== "object") return undefined
  const { title, members } = raw as { title?: unknown; members?: unknown }
  if (!members || typeof members !== "object" || Array.isArray(members)) return undefined
  const entries = Object.entries(members as { [name: string]: unknown })
    .filter((e): e is [string, RosterMember] => !!e[1] && typeof e[1] === "object")
  return { ...(typeof title === "string" && title ? { title } : {}), members: entries }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)

// agy's own precedence (sidecar `statusOf` + the roster's `killed` normalisation): killed first, then
// the transcript's reading, then wake_mode only when there is no transcript to go on.
export function agyMemberState(m: RosterMember, idle: boolean | undefined): AgySwarmState {
  const phase = str(m.phase)
  if (m.killed === true || m.desired_state === "KILLED" || phase === "KILLED") return "killed"
  if (phase && phase !== "RUNNING") return "stopped"
  if (idle !== undefined) return idle ? "waiting" : "working"
  return m.wake_mode === "mentions" || m.wake_mode === "anything" ? "waiting" : "working"
}

type Step = { type?: unknown; status?: unknown; tool_calls?: unknown; created_at?: unknown }
type ToolCall = { name?: unknown; args?: unknown }

function parseStep(line: string): Step | null {
  try {
    const step = JSON.parse(line) as unknown
    return step && typeof step === "object" ? (step as Step) : null
  } catch {
    return null
  }
}

const callsOf = (step: Step): ToolCall[] => (Array.isArray(step.tool_calls) ? (step.tool_calls as ToolCall[]) : [])

// Whether a transcript's newest step ENDS a turn — the member's run has stopped. A port of the agy swarm
// sidecar's `turnEnded`: a final reply with no tool calls, or the results of a tool batch that included
// `swarm_wait` once swarm_wait's own result is DONE. Anything newer (a system message from a background
// task, user input, a model error being retried) is mid-turn, and so is a torn final line.
export function agyTurnEnded(lines: readonly string[]): boolean {
  const results: Step[] = [] // tool results after the newest planner step, oldest first
  for (let i = lines.length - 1; i >= 0; i--) {
    const step = parseStep(lines[i]!)
    if (!step) return false
    if (step.type === "GENERIC") {
      results.unshift(step)
      continue
    }
    if (step.type !== "PLANNER_RESPONSE") return false
    const calls = callsOf(step)
    if (calls.length === 0) return results.length === 0
    const wait = calls.findIndex((c) => c?.name === "swarm_wait")
    return wait >= 0 && results.length >= calls.length && results[wait]!.status === "DONE"
  }
  return false
}

// What a WORKING member is doing right now: the newest planner step's tool calls, read off the current
// turn only. `activity` is the tool name(s); `activityDetail` the model's own one-line summary of the call
// (`toolSummary`), when it wrote one. agy JSON-encodes every argument value, so a summary arrives quoted.
export function agyCurrentActivity(lines: readonly string[]): { activity?: string; activityDetail?: string } {
  for (let i = lines.length - 1; i >= 0; i--) {
    const step = parseStep(lines[i]!)
    if (!step) return {}
    if (step.type === "GENERIC") continue
    if (step.type !== "PLANNER_RESPONSE") return {}
    const calls = callsOf(step).filter((c) => typeof c?.name === "string" && c.name)
    if (calls.length === 0) return {}
    const names = [...new Set(calls.map((c) => c.name as string))]
    const detail = calls.map((c) => toolSummary(c.args)).find((s) => s)
    return { activity: names.join(", "), ...(detail ? { activityDetail: detail } : {}) }
  }
  return {}
}

function toolSummary(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const raw = (args as { toolSummary?: unknown }).toolSummary
  if (typeof raw !== "string" || !raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined
  } catch {
    return raw.trim() || undefined
  }
}

// Steps are read off the END of the transcript: the turn judgement and the activity only ever look back to
// the newest planner step. A tool result is a preview (agy writes long output to `steps/<n>/output.txt`),
// so a window this size holds many steps; one that holds no planner step reads as mid-turn, which is
// agy's own answer for a line it cannot parse.
const TAIL_WINDOW = 512 * 1024
const HEAD_WINDOW = 16 * 1024

function readWindow(path: string, from: number, length: number): string | undefined {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch {
    return undefined
  }
  try {
    const buf = Buffer.allocUnsafe(length)
    const read = readSync(fd, buf, 0, length, from)
    return buf.toString("utf8", 0, read)
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

export type AgyTranscriptSummary = {
  idle: boolean
  startedAt?: string // the first step's created_at
  activity?: string
  activityDetail?: string
}

export function summarizeAgyTranscript(path: string, size: number): AgyTranscriptSummary | undefined {
  const from = Math.max(0, size - TAIL_WINDOW)
  const tail = readWindow(path, from, size - from)
  if (tail === undefined) return undefined
  let lines = tail.split("\n")
  if (from > 0) lines = lines.slice(1) // the window's first line is torn
  lines = lines.filter((l) => l.trim())
  const head = from === 0 ? tail.slice(0, HEAD_WINDOW) : readWindow(path, 0, Math.min(HEAD_WINDOW, size)) ?? ""
  // `created_at` precedes `content` in every step, so the first match is the first step's, even when that
  // step is longer than the head window.
  const startedAt = /"created_at":"([^"]+)"/.exec(head)?.[1]
  const idle = agyTurnEnded(lines)
  return { idle, ...(startedAt ? { startedAt } : {}), ...(idle ? {} : agyCurrentActivity(lines)) }
}

export type AgySwarmMember = {
  id: string
  /** Runtime id a fence or watch names this child by (swarm: roster name; subagent: conversationId). */
  taskId?: string
  name: string
  conversationId: string
  role?: string
  model?: string
  state: AgySwarmState
  transcriptPath: string
  startedAt?: string
  lastActivityAt?: string // the transcript's mtime
  activity?: string
  activityDetail?: string
}

export type AgySwarmLiveEntry = {
  name: string
  /** Runtime id a fence or watch names this child by; defaults to `name` when omitted. */
  taskId?: string
  startedAt: string
  model?: string
  transcriptPath: string
  state: AgySwarmLiveState
  activity?: string
  activityDetail?: string
}

export type AgySwarmRetiredEntry = {
  name: string
  taskId?: string
  startedAt?: string
  finishedAt?: string
  model?: string
  transcriptPath: string
}

// How the tracker publishes into the tailer's live/retired maps (implemented over its private entry types,
// so this module never imports them and is tested against a plain double).
export interface AgySwarmSink {
  // Surface or refresh a live member. Called again on every change of state or activity, and to
  // resurrect a member the roster brings back.
  setLive(id: string, entry: AgySwarmLiveEntry): void
  // Retire `id`: a live row moves into the finished ring; an id that is not live (a member killed before
  // ntwine first looked) goes straight into the ring from `entry`, so a finished swarm is still browsable.
  retire(id: string, entry: AgySwarmRetiredEntry | undefined, status: "completed" | "killed"): void
  // The agy-swarm ids currently live in the sink — what a restored state carries in from the tail cache,
  // reconciled against the roster on the first poll.
  liveIds(): readonly string[]
}

export interface AgySwarmTrackerDeps {
  sink: AgySwarmSink
  home?: string
  // The thread's own agy conversation: the swarm's coordinator, never listed as its own sub-agent.
  conversationId: string
  // Minimum gap between two reads of the disk (one roster stat plus one stat per unkilled member).
  intervalMs?: number
}

export interface AgySwarmTracker {
  poll(nowMs: number): void
  // The roster as last read — empty before the first read or for a thread with no swarm.
  members(): readonly AgySwarmMember[]
}

const POLL_INTERVAL_MS = 1_500

type FileStamp = { mtimeMs: number; size: number }

function stampOf(path: string): FileStamp | undefined {
  try {
    const s = statSync(path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return undefined
  }
}

const sameStamp = (a: FileStamp | undefined, b: FileStamp | undefined) => !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size

export function createAgySwarmTracker(deps: AgySwarmTrackerDeps): AgySwarmTracker {
  const home = deps.home ?? defaultAgyHome()
  const rosterPath = agySwarmRosterPath(home, deps.conversationId)
  const subAgentsDir = agySubAgentsDir(home, deps.conversationId)
  const interval = deps.intervalMs ?? POLL_INTERVAL_MS
  let nextPollMs = 0
  let rosterStamp: FileStamp | undefined
  let roster: AgyRoster | undefined
  // Per subagents/<conv>.json file: cached stamp and parsed record so unchanged descriptors aren't re-read.
  const subAgentFiles = new Map<string, { stamp: FileStamp; record: AgySubAgentRecord | undefined }>()
  // Per transcript path: the stamp it was summarised at, and the summary. A killed member's transcript is
  // read once (its head, for the start instant) and never again while it does not change.
  const summaries = new Map<string, { stamp: FileStamp; summary: AgyTranscriptSummary | undefined }>()
  // What was last published per id, so an unchanged member costs the sink nothing and a killed member is
  // put in the ring once rather than on every poll (the ring is bounded; re-inserting would churn it).
  const published = new Map<string, string>()
  let reconciled = false
  let current: AgySwarmMember[] = []

  function summary(path: string, stamp: FileStamp): AgyTranscriptSummary | undefined {
    const cached = summaries.get(path)
    if (cached && sameStamp(cached.stamp, stamp)) return cached.summary
    const value = summarizeAgyTranscript(path, stamp.size)
    summaries.set(path, { stamp, summary: value })
    return value
  }

  function readSwarmMembers(): AgySwarmMember[] | undefined {
    const stamp = stampOf(rosterPath)
    if (!stamp) return undefined
    if (!sameStamp(stamp, rosterStamp)) {
      let text: string
      try {
        text = readFileSync(rosterPath, "utf8")
      } catch {
        return undefined
      }
      const parsed = parseAgyRoster(text)
      // A roster caught mid-write does not parse: keep the last good one rather than retiring the swarm.
      if (!parsed) return roster ? membersOf(roster) : undefined
      roster = parsed
      rosterStamp = stamp
    }
    return roster ? membersOf(roster) : undefined
  }

  function readSubAgentMembers(skipConvs: ReadonlySet<string>): AgySwarmMember[] | undefined {
    let entries: string[]
    try {
      entries = readdirSync(subAgentsDir)
    } catch {
      return undefined
    }
    const out: AgySwarmMember[] = []
    const liveFiles = new Set<string>()
    for (const file of entries) {
      if (!file.endsWith(".json")) continue
      const fullPath = join(subAgentsDir, file)
      const fStamp = stampOf(fullPath)
      if (!fStamp) continue
      liveFiles.add(fullPath)
      let rec: AgySubAgentRecord | undefined
      const cached = subAgentFiles.get(fullPath)
      if (cached && sameStamp(cached.stamp, fStamp)) {
        rec = cached.record
      } else {
        try {
          const parsed = parseAgySubAgent(readFileSync(fullPath, "utf8"))
          // Mid-write tear: keep the last good record if we had one.
          rec = parsed ?? cached?.record
          if (parsed) subAgentFiles.set(fullPath, { stamp: fStamp, record: parsed })
        } catch {
          rec = cached?.record
        }
      }
      if (!rec) continue
      const conv = rec.conversationId
      if (conv === deps.conversationId || skipConvs.has(conv)) continue
      const transcriptPath = agyTranscriptPath(home, conv)
      const stamp = stampOf(transcriptPath)
      const killed = rec.state === "SUBAGENT_STATE_KILLED"
      const s = stamp ? (killed ? headOnly(transcriptPath, stamp) : summary(transcriptPath, stamp)) : undefined
      // Unlike a swarm member (which parks on a board in `waiting`), an `invoke_subagent` child stays
      // `SUBAGENT_STATE_ALIVE` even after its turn finishes so the parent can still `send_message` it.
      // Once its transcript ends (`idle === true`), retire it as `completed`; a later message flips
      // `idle` back to `false` and resurrects it into the live map.
      const state: AgySwarmState = killed ? "killed" : s?.idle === true ? "completed" : "working"
      const name = rec.role ?? rec.typeName ?? conv.slice(0, 8)
      out.push({
        id: agySubAgentId(conv),
        taskId: conv,
        name,
        conversationId: conv,
        ...(rec.role ? { role: rec.role } : {}),
        ...(rec.typeName ? { model: rec.typeName } : {}),
        state,
        transcriptPath,
        ...(s?.startedAt ? { startedAt: s.startedAt } : {}),
        ...(stamp ? { lastActivityAt: new Date(stamp.mtimeMs).toISOString() } : {}),
        ...(state === "working" && s?.activity ? { activity: s.activity } : {}),
        ...(state === "working" && s?.activityDetail ? { activityDetail: s.activityDetail } : {}),
      })
    }
    for (const k of subAgentFiles.keys()) {
      if (!liveFiles.has(k)) subAgentFiles.delete(k)
    }
    return out
  }

  function readMembers(): AgySwarmMember[] | undefined {
    const swarm = readSwarmMembers()
    // Swarm workers also have descriptors under `subagents/*.json`; deduplicate by conversationId so
    // `swarm/members.json` (which carries the short roster name, model, phase and wake_mode) wins.
    const swarmConvs = new Set((swarm ?? []).map((m) => m.conversationId))
    const subAgents = readSubAgentMembers(swarmConvs)
    if (!swarm && !subAgents) return undefined
    return [...(swarm ?? []), ...(subAgents ?? [])]
  }

  function membersOf(r: AgyRoster): AgySwarmMember[] {
    const out: AgySwarmMember[] = []
    for (const [name, m] of r.members) {
      const conv = str(m.conversation_id)
      if (!conv || conv === deps.conversationId) continue
      const transcriptPath = agyTranscriptPath(home, conv)
      const stamp = stampOf(transcriptPath)
      const killed = agyMemberState(m, undefined) === "killed"
      // A killed member is never asked whether its turn ended — only when it started.
      const s = stamp ? (killed ? headOnly(transcriptPath, stamp) : summary(transcriptPath, stamp)) : undefined
      const state = agyMemberState(m, s?.idle)
      const model = str(m.applied_model) ?? str(m.model) ?? str(m.desired_model)
      out.push({
        id: agySwarmMemberId(conv),
        name,
        conversationId: conv,
        ...(str(m.role) ? { role: str(m.role) } : {}),
        ...(model ? { model } : {}),
        state,
        transcriptPath,
        ...(s?.startedAt ? { startedAt: s.startedAt } : {}),
        ...(stamp ? { lastActivityAt: new Date(stamp.mtimeMs).toISOString() } : {}),
        ...(state === "working" && s?.activity ? { activity: s.activity } : {}),
        ...(state === "working" && s?.activityDetail ? { activityDetail: s.activityDetail } : {}),
      })
    }
    return out
  }

  function headOnly(path: string, stamp: FileStamp): AgyTranscriptSummary | undefined {
    const cached = summaries.get(path)
    if (cached && sameStamp(cached.stamp, stamp)) return cached.summary
    const head = readWindow(path, 0, Math.min(HEAD_WINDOW, stamp.size)) ?? ""
    const startedAt = /"created_at":"([^"]+)"/.exec(head)?.[1]
    const value: AgyTranscriptSummary = { idle: true, ...(startedAt ? { startedAt } : {}) }
    summaries.set(path, { stamp, summary: value })
    return value
  }

  return {
    members: () => current,
    poll(nowMs: number): void {
      if (nowMs < nextPollMs) return
      nextPollMs = nowMs + interval
      const members = readMembers()
      if (!members) {
        // No swarm (the common agy thread), or its roster vanished. Rows a restored state carried in for
        // a swarm that no longer exists must not read live forever.
        if (!reconciled) for (const id of deps.sink.liveIds()) deps.sink.retire(id, undefined, "completed")
        reconciled = true
        current = []
        return
      }
      current = members
      const seen = new Set<string>()
      // Killed first, oldest kill first, so the bounded ring keeps the NEWEST finished members.
      const ordered = [...members].sort((a, b) => rank(a) - rank(b) || (a.lastActivityAt ?? "").localeCompare(b.lastActivityAt ?? ""))
      for (const m of ordered) {
        seen.add(m.id)
        if (m.state === "killed" || m.state === "completed") {
          const sig = m.state
          if (published.get(m.id) === sig) continue
          published.set(m.id, sig)
          deps.sink.retire(m.id, {
            name: m.name,
            ...(m.taskId ? { taskId: m.taskId } : {}),
            transcriptPath: m.transcriptPath,
            ...(m.startedAt ? { startedAt: m.startedAt } : {}),
            ...(m.lastActivityAt ? { finishedAt: m.lastActivityAt } : {}),
            ...(m.model ? { model: m.model } : {}),
          }, m.state)
          continue
        }
        const sig = `${m.state}|${m.activity ?? ""}|${m.activityDetail ?? ""}|${m.model ?? ""}|${m.startedAt ?? ""}`
        if (published.get(m.id) === sig) continue
        published.set(m.id, sig)
        deps.sink.setLive(m.id, {
          name: m.name,
          ...(m.taskId ? { taskId: m.taskId } : {}),
          // A member with no transcript yet has just been added: its first sighting is the honest instant.
          startedAt: m.startedAt ?? new Date(nowMs).toISOString(),
          transcriptPath: m.transcriptPath,
          state: m.state,
          ...(m.model ? { model: m.model } : {}),
          ...(m.activity ? { activity: m.activity } : {}),
          ...(m.activityDetail ? { activityDetail: m.activityDetail } : {}),
        })
      }
      // A member that left the roster, or a row a restored state carried in that the roster never named.
      for (const id of reconciled ? [...published.keys()] : [...new Set([...published.keys(), ...deps.sink.liveIds()])]) {
        if (seen.has(id)) continue
        published.delete(id)
        deps.sink.retire(id, undefined, "completed")
      }
      reconciled = true
    },
  }
}

const rank = (m: AgySwarmMember) => (m.state === "killed" || m.state === "completed" ? 0 : 1)
