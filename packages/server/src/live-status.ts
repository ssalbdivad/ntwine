import type { TranscriptMessage } from "@ntwine/shared"
import type { ClaudeOneShot, ClaudeOneShotRequest } from "./backend/claude-oneshot.ts"
import { operatorMessages } from "./periodic-status.ts"
import { isBrokerClaudeRow, type SessionRow, type Storage } from "./storage.ts"
import { cleanThreadStatus } from "./thread-names.ts"

// THE WORKING STATUS: while a thread's turn runs, keep its status line naming the TASK it is on, and
// change it only when the work fundamentally moves (David 2026-09-29: "have each thread always
// display a brief status message of what it's working on when it's working and how long it has been
// working on that specific task — it should update status every time it fundamentally shifts what it
// is doing"). The elapsed half is `session.status_at`, which storage stamps only when the TEXT changes,
// so a check that keeps the task keeps its clock.
//
// periodic-status.ts owns the status at REST (every rest the conversation moved, Sonnet). This owns it while the
// turn runs, and hands back at the rest: `onTurnDone` reports whether the turn wore a working status, and
// the caller then forces one rest write so a rested card does not go on saying "Running the tests".
//
// COST, which is what the maintainer asked about first. One Sonnet one-shot per running thread at most
// every INTERVAL, and only when its transcript has actually moved (the tailer calls `onActivity` on a
// tick that folded new bytes of an in-flight turn) — a thread blocked in one long command costs nothing.
// Sonnet, not Haiku, and measured (2026-09-29, 22 checkpoints over two real worker transcripts): Haiku
// answered SAME 4 times in 22 and reworded a still-true status at almost every other check, which resets
// the clock the status exists to carry; it also narrated ("The agent has…") about one check in ten.
// Sonnet held the task through screenshot and typecheck steps and moved exactly when the developer's
// follow-up or a landing did. NTWINE_LIVE_STATUS_MODEL overrides it.
// The model is asked a yes/no-shaped question ("still on this task? reply SAME") over a bounded window,
// so a check is a few thousand input tokens and a handful out. The first check waits FIRST_MS into the
// turn, so a quick answer that rests in seconds never pays for one. The one-shot spawns a throwaway CLI
// session per call, so the context wires this to its OWN completer: a dispatch's name mint must not queue
// behind a fleet's status checks.
export const LIVE_STATUS_INTERVAL_MS = 120_000
export const LIVE_STATUS_FIRST_MS = 20_000
// A new turn resumes the previous turn's task — and its clock — only if it starts within this long of
// the last rest. A wake a minute later is the same stretch of work; a message the next morning is not,
// and "working on this for 14h" would count the night.
const RESUME_GAP_MS = 15 * 60_000
// The status sits inline after a one- or two-word name in the rail (Sidebar.tsx ThreadRow), where about
// 30 characters of 12px grey fit beside a typical name. The rail truncates anything longer, so this is a
// target for the model, not a clamp.
const LIVE_STATUS_MAX_WORDS = 4
const LIVE_STATUS_TARGET_CHARS = 30
const REQUEST_CHARS = 1_500
const ACTIVITY_LINES = 40
const ACTIVITY_LINE_CHARS = 300
const ACTIVITY_CHARS = 8_000

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** What the model reads: the operator's latest request, and the turn's recent activity as one line per
 *  assistant sentence-run or tool call, newest last. Undefined when there is nothing to read. */
export function liveActivity(messages: readonly TranscriptMessage[]): { request: string; activity: string } | undefined {
  const ops = operatorMessages(messages)
  const last = ops.at(-1)
  const from = last ? messages.indexOf(last) + 1 : 0
  const lines: string[] = []
  for (const m of messages.slice(from)) {
    if (m.boundary || m.queued) continue
    if (m.role === "user") {
      // A wake or a child's report can redirect the work as surely as the operator can.
      if (m.wake || m.peerFrom) lines.push(`[${m.peerFrom ? "sub-agent report" : "ntwine"}] ${clip(m.displayText ?? m.text, ACTIVITY_LINE_CHARS)}`)
      continue
    }
    if (m.kind) continue
    if (m.text.trim()) lines.push(`Agent: ${clip(m.text, ACTIVITY_LINE_CHARS)}`)
    for (const tool of m.tools) lines.push(`→ ${tool.name}: ${clip(tool.desc ?? tool.detail ?? "", 160)}`)
  }
  if (lines.length === 0) return undefined
  let activity = lines.slice(-ACTIVITY_LINES).join("\n")
  if (activity.length > ACTIVITY_CHARS) activity = `…${activity.slice(activity.length - ACTIVITY_CHARS)}`
  return { request: last ? clip(last.displayText ?? last.text, REQUEST_CHARS) : "", activity }
}

const LIVE_SYSTEM = "You keep the one-line status of a coding agent that is working right now, shown on a developer's dashboard with a clock of how long the agent has been on that task. You reply with the status alone, or with the single word SAME."

export function liveStatusRequest(input: { request: string; activity: string; current?: string }): ClaudeOneShotRequest {
  const lines = [
    ...(input.request ? ["The developer's latest request to the agent:", "<request>", input.request, "</request>", ""] : []),
    "The agent's recent activity, oldest first:",
    "<activity>",
    input.activity,
    "</activity>",
    "",
    input.current ? `The status currently shown: "${input.current}"` : "No status is shown yet.",
    "",
    "Rules:",
    "- The status names the TASK the agent is on — the goal a developer would recognize, at the level of their request — never the step or command it is on right now. Good: \"Fixing the resolver cache miss\", \"Testing the rail fix\", \"Landing the fix on main\", \"Reviewing PR #391\". Too narrow: \"Capturing screenshots of the variants\", \"Reading Sidebar.tsx\", \"Typechecking the connector\".",
    ...(input.current
      ? [
        "- Reply SAME when the agent is still pursuing the goal the current status names, however many different commands, files, screenshots or iterations that involves. Rewording a status that is still true is wrong: its clock resets. Most checks should answer SAME.",
        "- Write a new status only when the work has fundamentally moved: the developer asked for something else, the agent moved onto a different problem, or it clearly finished one phase and started another (for example it finished the fix and is now landing it, or finished investigating and is now implementing).",
      ]
      : []),
    `- A status starts with an -ing verb and is at most ${LIVE_STATUS_MAX_WORDS} words (about ${LIVE_STATUS_TARGET_CHARS} characters) — it sits beside the thread's name in a narrow sidebar and is read at a glance. Say the high-level what, not the detail. Sentence case, no trailing period, no quotes.`,
    "- Never generic (\"Working on it\", \"Continuing the task\"), and never \"the user\".",
    "",
    input.current ? "Reply with SAME or the new status, and nothing else." : "Reply with the status alone.",
  ]
  return { system: LIVE_SYSTEM, prompt: lines.join("\n"), model: process.env.NTWINE_LIVE_STATUS_MODEL ?? "sonnet" }
}

/** A model's answer: `same` to keep the current status, a cleaned status, or undefined for neither. */
export function parseLiveStatus(raw: string): { same: true } | { status: string } | undefined {
  const first = raw.split("\n").map((line) => line.trim()).find(Boolean) ?? ""
  if (/^["'`*]*same\b/i.test(first)) return { same: true }
  const status = cleanThreadStatus(first)
  // A status opens on an -ing verb. Anything else is the model narrating ("The agent has…", "Reviewing
  // the agent's activity" aside) — measured on real transcripts, the smaller model does it about one
  // check in ten — and is dropped rather than shown; the current status stands.
  if (!status || !/^\p{L}+ing\b/u.test(status) || /\b(the agent|the developer|the user)\b/i.test(status)) return undefined
  return { status }
}

export interface LiveStatusDeps {
  storage: Pick<Storage, "getSession" | "setStatus">
  /** The model. Absent ⇒ no working status is ever written. */
  complete?: ClaudeOneShot
  /** `forkAnchor` is the row's SessionRow.fork_anchor — a forked thread is read from its fork point. */
  readMessages: (sessionId: string, forkAnchor?: string | null) => TranscriptMessage[] | Promise<TranscriptMessage[]>
  onStatus: () => void
  onError?: (slug: string, error: unknown) => void
  now?: () => number
  intervalMs?: number
  firstMs?: number
}

export interface LiveStatus {
  /** Call on every tick that folded new transcript bytes of an IN-FLIGHT turn. Fire-and-forget. */
  onActivity(row: SessionRow): void
  /** Call at every live rest. True when the turn that ended wore a working status. */
  onTurnDone(row: SessionRow): boolean
}

interface KeyState {
  turnOpen: boolean
  turnStartedAt: number
  turnEndedAt?: number
  nextCheckAt: number
  inFlight: boolean
  wroteThisTurn: boolean
  // The last WORKING status and the instant its task began. Kept across a rest because the rest writer
  // overwrites the row's text, and a short-gap resume of the same task should get its clock back.
  last?: { status: string; at: string }
}

export function createLiveStatus(deps: LiveStatusDeps): LiveStatus {
  const now = deps.now ?? Date.now
  const intervalMs = deps.intervalMs ?? LIVE_STATUS_INTERVAL_MS
  const firstMs = deps.firstMs ?? LIVE_STATUS_FIRST_MS
  const states = new Map<string, KeyState>()
  const keyOf = (row: SessionRow) => `${row.slug}\0${row.session_id}`

  const api: LiveStatus = {
    onActivity(row) {
      // Broker Claude rows only, like periodic-status: `readMessages` reads a Claude transcript.
      const complete = deps.complete
      if (!complete || !isBrokerClaudeRow(row)) return
      const key = keyOf(row)
      const at = now()
      let st = states.get(key)
      if (!st) {
        st = { turnOpen: false, turnStartedAt: at, nextCheckAt: at, inFlight: false, wroteThisTurn: false }
        states.set(key, st)
      }
      if (!st.turnOpen) {
        st.turnOpen = true
        st.turnStartedAt = at
        st.wroteThisTurn = false
        st.nextCheckAt = at + firstMs
        // The FIRST check runs on a timer, not on the next transcript write: a turn that goes straight
        // into one long foreground command writes nothing until it returns, and measured on a real
        // worker (a 45s `sleep`) it showed no status at all for the whole command. Later checks need no
        // timer — with nothing written, nothing has moved, and the status standing is still true.
        const opened = st
        setTimeout(() => {
          if (!opened.turnOpen || opened.turnStartedAt !== at) return
          const fresh = deps.storage.getSession(row.slug)
          if (fresh?.session_id === row.session_id) api.onActivity(fresh)
        }, firstMs).unref?.()
      }
      if (st.inFlight || at < st.nextCheckAt) return
      st.nextCheckAt = at + intervalMs
      const state = st
      state.inFlight = true
      void (async () => {
        // Awaited: the context hands in readTranscriptYielding, so a cold fold of a large transcript
        // yields the event loop instead of holding it for seconds (transcript.ts).
        const read = liveActivity(await deps.readMessages(row.session_id, row.fork_anchor))
        if (!read || !state.turnOpen) return
        const resumes = state.wroteThisTurn || (state.turnEndedAt !== undefined && state.turnStartedAt - state.turnEndedAt < RESUME_GAP_MS)
        const current = resumes ? state.last : undefined
        const raw = await complete(liveStatusRequest({ ...read, current: current?.status }))
        // The turn rested while the model thought: the rest writer owns the status now.
        if (!state.turnOpen) return
        const answer = parseLiveStatus(raw)
        if (!answer) return
        let next: { status: string; at: string }
        if ("same" in answer) {
          if (!current) return
          next = current
        } else {
          next = answer.status === current?.status ? current : { status: answer.status, at: new Date(now()).toISOString() }
        }
        state.last = next
        state.wroteThisTurn = true
        // Keyed on the session it was read from. `next.at` restores a resumed task's clock after the
        // rest writer replaced its text; storage keeps the old instant when the text is unchanged.
        const stored = deps.storage.getSession(row.slug)
        if (stored?.session_id !== row.session_id) return
        if (stored.status === next.status && stored.status_at === next.at) return
        if (deps.storage.setStatus(row.slug, row.session_id, next.status, next.at)) deps.onStatus()
      })()
        .catch((error: unknown) => deps.onError?.(row.slug, error))
        .finally(() => { state.inFlight = false })
    },
    onTurnDone(row) {
      const st = states.get(keyOf(row))
      if (!st) return false
      st.turnOpen = false
      st.turnEndedAt = now()
      const wore = st.wroteThisTurn
      st.wroteThisTurn = false
      return wore
    },
  }
  return api
}
