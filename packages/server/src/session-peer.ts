// WHICH THREAD SENT THIS? — the sender of a cross-session message, as a Frizz thread.
//
// One top-level session can message another through Claude Code's own channel (`SendMessage` to a
// session name), and the receiving transcript records only the sender's messaging SOCKET and its Claude
// Code session NAME (see parseCrossSessionMessage in shared). Neither is a Frizz identity: the name is
// `<cwd basename>-<2 hex>`, so every thread in this repo is `frizz-<something>` and two can collide.
//
// The socket is the handle that leads somewhere. Claude Code keeps a registry of its LIVE sessions —
// `<config dir>/sessions/<pid>.json`, one per running process — and each entry names the session's
// `messagingSocketPath` beside its `sessionId`. The socket path is `/tmp/cc-socks/<pid>.sock`, so the
// pid in it picks the registry entry, the entry's socket and name confirm it is the same process, and its
// session id is the one a Frizz thread row pins. Measured on this machine 2026-10-08: the coordinator's
// message into a watcher thread carried `from="uds:/tmp/cc-socks/2908.sock" from-name="frizz-11"`, and
// `~/.claude/sessions/2908.json` named session 5c6eacc1-…, the coordinator thread's own session.
//
// THE REGISTRY ONLY HOLDS LIVE PROCESSES, so a resolution is REMEMBERED: once a socket and name have led
// to a session, that pairing is kept in `session-peers.json` under Frizz's state root. A thread whose
// sender has since exited still links to it, across a Frizz restart too. A pid the OS later reuses
// comes with a different name (the name is derived from the session), so the pairing key holds both.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { TranscriptMessage } from "@frizz/shared"

type SessionPeer = NonNullable<TranscriptMessage["sessionPeer"]>
export type SessionPeerThread = NonNullable<SessionPeer["thread"]>

// Every directory a running Claude Code may have registered itself in: the configured one first, and
// the default beside it, because Frizz's own workers run under the default even when this server was
// started with an override (and the reverse).
export function claudeSessionDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dirs = [join(home, ".claude", "sessions")]
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  if (override) dirs.unshift(join(override, "sessions"))
  return [...new Set(dirs)]
}

const SOCKET_PID = /[\\/](\d+)\.sock$/

// The sender's Claude session id, read off the live-session registry, or undefined when no registered
// process answers to this socket (and, when given, this name).
export function sessionIdForPeerSocket(peer: Pick<SessionPeer, "socket" | "name">, dirs: readonly string[]): string | undefined {
  const socket = peer.socket?.replace(/^uds:/, "")
  const pid = socket ? SOCKET_PID.exec(socket)?.[1] : undefined
  if (!socket || !pid) return undefined
  for (const dir of dirs) {
    let entry: { sessionId?: unknown; messagingSocketPath?: unknown; name?: unknown }
    try {
      entry = JSON.parse(readFileSync(join(dir, `${pid}.json`), "utf8"))
    } catch {
      continue
    }
    if (entry.messagingSocketPath !== socket) continue
    if (peer.name && typeof entry.name === "string" && entry.name !== peer.name) continue
    if (typeof entry.sessionId === "string" && entry.sessionId) return entry.sessionId
  }
  return undefined
}

export interface SessionPeerResolver {
  (peer: SessionPeer, receiverProjectId: string): SessionPeerThread | undefined
}

export function createSessionPeerResolver(deps: {
  // The thread a Claude session id belongs to, in any project this server knows. `projectId` is the
  // sender's project; `project` its URL slug.
  findThread: (sessionId: string) => { projectId: string; project?: string; slug: string; title: string } | undefined
  sessionDirs?: () => readonly string[]
  // Where remembered pairings live. Absent ⇒ remembered for this process only (tests).
  memoryFile?: string
}): SessionPeerResolver {
  const sessionDirs = deps.sessionDirs ?? (() => claudeSessionDirs())
  let remembered: Record<string, string> | undefined
  const load = (): Record<string, string> => {
    if (remembered) return remembered
    remembered = {}
    if (deps.memoryFile) {
      try {
        const parsed = JSON.parse(readFileSync(deps.memoryFile, "utf8"))
        if (parsed && typeof parsed === "object") for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") remembered[k] = v
      } catch {
        // Absent or unreadable: nothing remembered yet.
      }
    }
    return remembered
  }
  const remember = (key: string, sessionId: string): void => {
    const all = load()
    if (all[key] === sessionId) return
    all[key] = sessionId
    if (!deps.memoryFile) return
    try {
      mkdirSync(dirname(deps.memoryFile), { recursive: true })
      const tmp = `${deps.memoryFile}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(all))
      renameSync(tmp, deps.memoryFile)
    } catch {
      // Losing the memory costs a link once the sender exits, never a render.
    }
  }
  return (peer, receiverProjectId) => {
    if (!peer.socket) return undefined
    const key = `${peer.socket}\n${peer.name ?? ""}`
    // The live registry first: it is the authority while the sender runs, and it is what a pid reused
    // by a later process with the same name would correct.
    const live = sessionIdForPeerSocket(peer, sessionDirs())
    if (live) remember(key, live)
    const sessionId = live ?? load()[key]
    const found = sessionId ? deps.findThread(sessionId) : undefined
    if (!found) return undefined
    const { projectId, project, ...thread } = found
    // The project slug rides only when the sender is in ANOTHER project — the line then links across
    // projects; absent, the link stays inside the page the reader is on.
    return projectId === receiverProjectId || !project ? thread : { ...thread, project }
  }
}

// Fill in `sessionPeer.thread` on every cross-session message the resolver can place. Returns the input
// array unchanged when nothing resolved, so a transcript with no such message costs one pass.
export function projectTranscriptSessionPeers(
  messages: readonly TranscriptMessage[],
  resolve: (peer: SessionPeer) => SessionPeerThread | undefined,
): TranscriptMessage[] {
  const cache = new Map<string, SessionPeerThread | undefined>()
  let changed = false
  const out = messages.map((message) => {
    const peer = message.sessionPeer
    if (!peer?.socket) return message
    const key = `${peer.socket}\n${peer.name ?? ""}`
    if (!cache.has(key)) cache.set(key, resolve(peer))
    const thread = cache.get(key)
    if (!thread) return message
    changed = true
    return { ...message, sessionPeer: { ...peer, thread } }
  })
  return changed ? out : (messages as TranscriptMessage[])
}
