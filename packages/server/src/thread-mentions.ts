import { replyWaitOf, subAgentAddress, subAgentChain, subAgentHandle, threadHandle } from "@ntwine/shared"
import { foldThreadName, type NamedThread } from "./thread-names.ts"

// ONE THREAD POINTING AT ANOTHER BY HANDLE — "ask @shell-budgets about this", "reconcile with
// @focus-mode" (David 2026-09-29). The handle is the kebab-case form of the thread's name (shared
// thread-handle.ts), which is what the board SHOWS, so the operator and the worker type the same thing.
//
// Both sides are folded from the HANDLE with its punctuation squeezed out first, never from the stored
// words: `foldThreadName` strips a plural on the LAST word, and "Dev ops" is two words ("dev" + "ops",
// too short to strip) while `dev-ops` squeezed is one ("devops" → "devop"). Squeezing first makes
// `dev-ops`, `devOps` and `devops` agree — the web's `foldHandle` is the same key.

/** The handle a named thread is addressed by — its kebab-case name, or, for a name too long to have one
 *  (a legacy sentence title, a long session title), its SLUG, which is already kebab-case and resolves
 *  the same way — so every thread is addressable, and always by something shaped like a handle. */
export function handleOf(t: Pick<NamedThread, "name" | "slug">): string {
  return threadHandle(t.name) ?? t.slug
}

function key(handle: string): string {
  return foldThreadName(handle.replace(/^@/, "").replace(/[^\p{L}\p{N}]+/gu, ""))
}

/** The thread `handle` names: an OPEN thread first (names are unique among those), else the most recent
 *  finished one that carried it. The SLUG resolves too, folded the same way: it is minted from the
 *  dispatch title, so `@tea-recipes` still finds a thread dispatched as "Tea recipes" whose shown name has
 *  since become Claude's own session title (seen on a real run, 2026-09-29). */
export function resolveThreadHandle(handle: string, threads: readonly NamedThread[]): NamedThread | undefined {
  const bare = handle.trim().replace(/^@/, "")
  const want = key(bare)
  if (!want) return undefined
  // A name outranks a slug, an exact slug a folded one. Kebab handles made this ordering load-bearing: a
  // handle and a slug are now spelled alike, so `@focus-mode` literally equals the slug of an older
  // thread dispatched as "Focus mode" and since renamed, while another thread is NAMED that now.
  const named = threads.filter((t) => key(handleOf(t)) === want)
  const exact = named.length ? named : threads.filter((t) => t.slug === bare)
  const hits = exact.length ? exact : threads.filter((t) => key(t.slug) === want)
  return hits.find((t) => t.open) ?? [...hits].sort((a, b) => b.at - a.at)[0]
}

/** The handles a worker can use, open threads first and newest first — what a miss is answered with. */
export function knownHandles(threads: readonly NamedThread[], exceptSlug?: string, cap = 40): string[] {
  return [...threads]
    .filter((t) => t.slug !== exceptSlug)
    .sort((a, b) => Number(b.open) - Number(a.open) || b.at - a.at)
    .slice(0, cap)
    .map((t) => `@${handleOf(t)}${t.open ? "" : " (done)"}`)
}

// A THREAD'S SUB-AGENTS, BY ADDRESS — `port-the-parser.cache-keys` (shared thread-handle.ts), resolved against
// the thread's sub-agent DIRECTORY: every child it ever dispatched, live first, then finished ones newest
// first (tailer subAgentDirectory). A name reused over a thread's life — a second "Review" an hour after the
// first — therefore means the one still running, else the latest, the way a thread handle means the open
// thread before a finished one; the id always names exactly one.

type Child = { readonly id: string; readonly label: string; readonly parentId?: string; readonly state: string; readonly outcome?: string }

/** The sub-agent `segments` walks down to under one thread, or undefined. Each segment matches a child
 *  of the one before it (the thread's own children first) by its handle, folded like a thread's, or by
 *  its id. Among several matches the directory's order decides — live before finished, newest finished
 *  first — with a RUNNING child ahead of a quiet live one. */
export function resolveSubAgent<T extends Child>(segments: readonly string[], agents: readonly T[]): T | undefined {
  let parentId: string | undefined
  let hit: T | undefined
  for (const segment of segments) {
    const want = key(segment)
    const matches = agents.filter((a) => a.parentId === parentId && (a.id === segment || (want !== "" && key(subAgentHandle(a.label) ?? "") === want)))
    hit = matches.find((a) => a.state === "running") ?? matches[0]
    if (!hit) return undefined
    parentId = hit.id
  }
  return hit
}

/** The addresses a miss is answered with, live first and finished ones tagged, capped like thread
 *  handles. A child with no handle (a sentence-length description) has no address and is left out. */
export function subAgentAddresses(threadHandle: string, agents: readonly Child[], cap = 40): string[] {
  return agents
    .flatMap((a) => {
      const chain = subAgentChain(agents, a.id)
      return chain ? [`@${subAgentAddress(threadHandle, chain)}${a.state === "done" ? " (done)" : ""}`] : []
    })
    .slice(0, cap)
}

/** How many messages one thread may send ANOTHER per hour. Two workers told to "reconcile with each
 *  other" can each read every reply as something to answer; a loop between them costs a turn per message
 *  on both sides, and nothing a human sees would stop it. Ten is far past any real exchange. */
export const THREAD_MESSAGE_HOURLY_CAP = 10

// The delivered text lives in @ntwine/shared beside its parser (parseThreadMessage), because the chat
// rebuilds the message from it.
export { threadMessageBody } from "@ntwine/shared"

// A REPLY WAIT's prompt format and its reader live in @ntwine/shared (thread-handle.ts), because the
// resting card reads it too.
export { isReplyWaitFor, replyWaitOf, replyWaitPrompt } from "@ntwine/shared"

export function isReplyWait(prompt: string): boolean {
  return replyWaitOf(prompt) !== undefined
}

/** The key a `threads:` fence entry is checked by, among a thread's armed-timer keys (awaiting.ts): the
 *  handle or slug folded as every handle is, so `@Shell-Budgets` and `shellBudgets` name one wait. */
export function threadAwaitKey(value: string): string {
  return `thread:${key(value)}`
}

/** What a fence's `threads:` list is checked against: every armed timer's id, and for each reply wait
 *  among them the key of the handle it was armed under and of the slug it waits on. A reply wait IS a
 *  timer, so the one set the `timers:` check already reads carries both, and every caller that hands a
 *  park check its armed timers hands it the awaited threads with them. */
export function armedTimerKeys(timers: readonly { id: string; prompt: string }[]): Set<string> {
  const keys = new Set<string>()
  for (const t of timers) {
    keys.add(t.id)
    const wait = replyWaitOf(t.prompt)
    if (wait) for (const name of [wait.handle, wait.slug]) keys.add(threadAwaitKey(name))
  }
  return keys
}
