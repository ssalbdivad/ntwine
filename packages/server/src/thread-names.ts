import { THREAD_HANDLE_MAX_CHARS, addressSegments, threadHandle, threadMentions } from "@ntwine/shared"
import { sessionTitleLocked, type SessionRow, type Storage } from "./storage.ts"
import type { ClaudeOneShot, ClaudeOneShotRequest } from "./backend/claude-oneshot.ts"

// A THREAD'S NAME AND ITS STATUS ARE TWO DIFFERENT THINGS (David 2026-09-29).
//
// The NAME is one or two words: the SUBJECT of the thread — "Shell budgets", "Focus mode", "ArkType
// perf" — never the action taken ("Fix the shell budget default"). In his words: "choose ideal two words
// to differentiate not necessarily based on prompt but best 1 or 2 word summary of intent - the sort of
// subject of the prompt rather than exactly what was done".
//
// A NAME IS THE THREAD'S ID, SO IT IS FINAL THE MOMENT IT EXISTS (David 2026-09-30: "once someone
// sees the id, it cannot change"). The board shows a name as its `@handle`, and the operator types that
// handle into other threads' prompts, so a name that moves strands every mention of it. The first name to
// land stands: a caller's title (a spinoff, `spawn_thread`), else ntwine's mint, else the Codex marker,
// else — only for a thread none of those could name — the worker's own `mcp__ntwine__title`. Only a human
// rename changes it after that. Two things used to move it and no longer can: Claude's own session title,
// which showed as the name until the mint landed (and outranked a spinoff's name for good — a thread
// dispatched as "Cache review" read `@pluggable-cache-store-changes-evaluation`), and the worker's
// "correct it once after orienting" rename (`perf-review` became a sentence and then `perf-bench`).
//
// The STATUS is the part that is allowed to move: a short phrase of what is happening NOW, rewritten at
// every rest the conversation moved (periodic-status.ts). It used to be the name itself being rewritten, and that is
// the conflation this module ends.
//
// NAMES ARE NEVER DUPLICATED: "that has to be part of the prompt". No two non-archived threads may share
// a name once case and punctuation are folded away, and every writer is told the names already taken
// rather than finding out afterwards. The rule is enforced at each writer — the dispatch mint and the AI
// rename (here), the worker's own `mcp__ntwine__title` and a human rename (router.ts), and the Codex
// first-output marker (tailer.ts) — because a writer that was merely ASKED to be distinct will eventually
// not be.
//
// THE SET IS EVERY PROJECT THIS SERVER HAS OPEN, not the thread's own (2026-10-09). A handle is resolved
// in the caller's project first and only falls through to the others when nothing there answers
// (router.ts `resolveElsewhere`), so a local name equal to another project's open thread SHADOWS that
// thread: an ntwine-project thread auto-named "Issues audit" beside arktype's open `@issues-audit` made
// `@issues-audit` answer the caller itself, and `@issues-audit.<sub-agent>` report no sub-agents. The
// namer had been told only its own project's names, and its prompt @-mentioned the arktype thread — so a
// name the request MENTIONS is taken too (`mentionedHandles`), open, done or not a thread at all: a thread
// named after a handle its own request points at has made that pointer ambiguous from birth.

export const THREAD_NAME_MAX_WORDS = 2
// The status line's target and its hard clamp. The model is asked for ~60; the clamp only exists so a
// model that ignores the ask cannot push a paragraph onto the card header.
export const THREAD_STATUS_TARGET_CHARS = 60
const THREAD_STATUS_MAX_CHARS = 80
// How many taken names ride a naming prompt. Every OPEN thread matters (those are the ones a new name must
// not collide with), but a board with hundreds of open threads should not turn a two-word ask into a
// 4k-token prompt; the newest are the ones a near-duplicate is likely to be. Recently DONE names ride too,
// capped lower — they are not enforced (a finished thread's name is free again), but a new thread named
// exactly like yesterday's finished one reads as the same work.
const PROMPT_OPEN_NAMES = 60
const PROMPT_DONE_NAMES = 20
// Enough of the request to find its subject, bounded well under anything a one-shot should carry.
const SOURCE_CHARS = 4_000
const CONVERSATION_CHARS = 12_000

/** The comparison key: case, diacritics, punctuation AND spacing folded away, so "Focus mode",
 *  "focus-mode" and "Focus  Mode!" are one name — and a plain plural on the last word, so "Shell budget"
 *  cannot sit beside "Shell budgets" as if it were a different thread. Empty for a name with no letters
 *  or digits. */
export function foldThreadName(name: string): string {
  const words = name.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const last = words.length - 1
  if (last >= 0 && words[last]!.length > 3 && words[last]!.endsWith("s") && !words[last]!.endsWith("ss")) {
    words[last] = words[last]!.slice(0, -1)
  }
  return words.join("")
}

export interface NamedThread {
  slug: string
  name: string
  /** Not archived — the set a name must be unique within. */
  open: boolean
  /** Recency, for which names ride a prompt first (epoch ms). */
  at: number
  /** Set only on a thread of ANOTHER open project (`openThreadsElsewhere`): that project's name. */
  project?: string
}

/** The row's persisted NAME — a human's, a caller's dispatch title, or a machine name that landed (the
 *  mint, the Codex marker, the worker's own) — mirroring the web's `titleSource`. Undefined while the row
 *  has none: its stored text is then the dispatch chop, a placeholder. The transcript's live session
 *  title is never a name — it moves, and a name may not (see the header). */
export function rowThreadName(row: Pick<SessionRow, "title" | "title_auto" | "title_locked" | "title_agent">): string | undefined {
  if (!sessionTitleLocked(row) && !row.title_agent && row.title_auto === 1) return undefined
  return row.title?.trim() || undefined
}

/** Every row as a NamedThread. A row with no name yet carries the empty name, which holds nothing in the
 *  uniqueness check and is addressed by its slug (thread-mentions.ts `handleOf`) — the one id it has that
 *  cannot change. */
export function projectThreadNames(rows: readonly SessionRow[]): NamedThread[] {
  const out: NamedThread[] = []
  for (const row of rows) {
    const name = rowThreadName(row) ?? ""
    const at = Date.parse(row.rested_at ?? row.spawned_at)
    out.push({
      slug: row.slug,
      name,
      open: row.state !== "archived" && row.archived !== 1,
      at: Number.isFinite(at) ? at : 0,
    })
  }
  return out
}

/** The OPEN threads of every project this server has open other than `selfId`, each marked with its
 *  project — the rest of the set a name must be unique within (see the header). Read from each project's
 *  storage, not its namer, so no namer ever recurses into another. */
export function openThreadsElsewhere(
  tenants: ReadonlyArray<{ project: { id: string; name: string }; ctx?: { storage: Pick<Storage, "allSessions"> } }>,
  selfId: string,
): NamedThread[] {
  const out: NamedThread[] = []
  for (const { project, ctx } of tenants) {
    if (!ctx || project.id === selfId) continue
    for (const t of projectThreadNames(ctx.storage.allSessions())) if (t.open) out.push({ ...t, project: project.name })
  }
  return out
}

/** The OPEN thread already called `name`, if any: one of `threads` other than `exceptSlug`, else one of
 *  `elsewhere` — another project's, where `exceptSlug` means nothing (slugs are unique only within one). */
export function nameHolder(
  name: string,
  threads: readonly NamedThread[],
  exceptSlug?: string,
  elsewhere: readonly NamedThread[] = [],
): NamedThread | undefined {
  const key = foldThreadName(name)
  if (!key) return undefined
  return threads.find((t) => t.open && t.slug !== exceptSlug && foldThreadName(t.name) === key) ??
    elsewhere.find((t) => t.open && foldThreadName(t.name) === key)
}

/** The comparison key of a HANDLE as `@` mentions spell it, and of a name: punctuation squeezed out
 *  BEFORE folding, as thread-mentions.ts resolves one, so `dev-ops` and "Dev ops" agree. */
function handleKey(handle: string): string {
  return foldThreadName(handle.replace(/^@/, "").replace(/[^\p{L}\p{N}]+/gu, ""))
}

/** The thread handles `source` @-mentions, keyed by `handleKey` — only the thread segment of a sub-agent
 *  address (`@issues-audit.redesign` mentions `issues-audit`). */
export function mentionedHandles(source: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const mention of threadMentions(source)) {
    const handle = addressSegments(mention)[0] ?? ""
    const key = handleKey(handle)
    if (key && !out.has(key)) out.set(key, handle)
  }
  return out
}

/** The names a naming prompt lists as taken: the open threads — this project's and every other open
 *  project's (`elsewhere`) — then this project's recently done ones, newest first within each, capped,
 *  one entry per folded name. */
export function namesForPrompt(threads: readonly NamedThread[], exceptSlug?: string, elsewhere: readonly NamedThread[] = []): string[] {
  const seen = new Set<string>()
  const all = [...threads.filter((t) => t.slug !== exceptSlug), ...elsewhere.filter((t) => t.open)]
  const pick = (open: boolean, cap: number) =>
    all
      .filter((t) => t.open === open)
      .sort((a, b) => b.at - a.at)
      .filter((t) => {
        const key = foldThreadName(t.name)
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, cap)
      .map((t) => t.name)
  return [...pick(true, PROMPT_OPEN_NAMES), ...pick(false, PROMPT_DONE_NAMES)]
}

const NAMER_SYSTEM = "You name threads on a developer's dashboard of coding-agent threads. You reply with the name alone."

/** THE NAMING PROMPT. The instructions ride the user turn, not only the system prompt: measured on Haiku
 *  4.5 (2026-09-29), a request left bare in the user turn was ANSWERED — "Could you provide more context
 *  about …" — rather than named, while the same request fenced as data under the instructions was named. */
export function namingRequest(
  source: string,
  taken: readonly string[],
  rejected?: { name: string; reason: string },
): ClaudeOneShotRequest {
  const request = source.length > SOURCE_CHARS ? `${source.slice(0, SOURCE_CHARS)}…` : source
  const lines = [
    "Name a thread on a developer's dashboard of coding-agent threads. The name is how they tell this thread apart from every other one at a glance.",
    "",
    "Rules:",
    "- ONE or TWO words. Never more.",
    `- SHORT: the name is typed as a kebab-case @handle ("Shell budgets" → @shell-budgets), which must be at most ${THREAD_HANDLE_MAX_CHARS} characters. Prefer short, plain words.`,
    "- Name the SUBJECT or intent of the request, not the action taken: \"Shell budgets\", \"Focus mode\", \"ArkType perf\" — never \"Fix the shell budget default\".",
    "- No request verbs: fix, add, update, investigate, implement, check, refactor.",
    "- Sentence case: capitalize the first word only, plus proper nouns. Spell product names and identifiers exactly as the request spells them.",
    "- The name must differ from every name already taken below, ignoring case and punctuation. If the obvious subject is taken, pick the word that sets THIS thread apart from that one.",
    "",
    "Names already taken:",
    ...(taken.length ? taken.map((name) => `- ${name}`) : ["(none)"]),
    "",
    "The request:",
    "<request>",
    request,
    "</request>",
    "",
  ]
  if (rejected) lines.push(`Your previous answer, "${rejected.name}", ${rejected.reason}. Choose another.`, "")
  lines.push("Reply with the name alone: no quotes, no punctuation, no explanation.")
  return { system: NAMER_SYSTEM, prompt: lines.join("\n") }
}

const STATUS_SYSTEM = "You write the one-line live status of a coding-agent thread on a developer's dashboard. You reply with the status line alone."

/** THE STATUS PROMPT: what is happening now, from the last few exchanges — never the name again. */
export function statusRequest(name: string | undefined, conversation: string): ClaudeOneShotRequest {
  const body = conversation.length > CONVERSATION_CHARS ? `…${conversation.slice(conversation.length - CONVERSATION_CHARS)}` : conversation
  // Measured against a real five-message thread (2026-09-29). Haiku 4.5, with the rules BEFORE the
  // conversation, answered "Thread complete, user satisfied" and "Completed README review" (the name
  // again); with the conversation first and the rules after it, "Answered project questions, awaiting
  // next task" — better, but on the real stack it still wrote "User satisfied with README overview,
  // thread paused", straight through the rule that forbids both words. Sonnet on the same input, three
  // of three: "Answered four README questions, nothing edited" and the like. A status is written in the
  // background every fifth message, so it can afford the larger model; the NAME, which a fresh dispatch
  // waits on, stays on the smallest one.
  const lines = [
    "Below is the most recent part of a conversation between a developer and a coding agent.",
    "",
    "<conversation>",
    body,
    "</conversation>",
    "",
    "Write the live STATUS line for this thread on the developer's dashboard: where the work stands RIGHT NOW, judged mostly from the LAST exchange above.",
    "",
    "Rules:",
    `- One short phrase, at most ${THREAD_STATUS_TARGET_CHARS} characters.`,
    "- Say what the agent is doing, what it just finished, or what it is waiting on — and name the specific thing (file, test, PR, finding, decision): \"Waiting on CI for the budget fix\", \"Pushed the rail fix, awaiting review\", \"Asked whether to drop the mono font\".",
    "- Never generic: not \"Thread complete\", \"Task done\", \"User satisfied\", \"Working on it\". Do not say \"the user\" or \"the thread\".",
    ...(name ? [`- The thread is already named "${name}" and the status sits beside that name, so do not repeat it.`] : []),
    "- Sentence case, no trailing period, no quotes.",
    "",
    "Reply with the status line alone.",
  ]
  return { system: STATUS_SYSTEM, prompt: lines.join("\n"), model: "sonnet" }
}

// Words a distinguishing fallback never borrows from the request.
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto", "about", "then", "than", "when", "what",
  "which", "where", "while", "should", "would", "could", "can", "will", "just", "also", "please", "make", "sure",
  "our", "your", "their", "its", "not", "but", "are", "was", "were", "been", "have", "has", "had", "does", "did",
  "lets", "need", "needs", "want", "some", "any", "all", "one", "two", "new", "now", "why", "how", "there",
  // Request verbs: the name is the subject, never the action, so a fallback word never is one either.
  "fix", "add", "update", "investigate", "implement", "check", "refactor", "look", "see", "use", "get", "let",
  "raise", "lower", "change", "remove", "drop", "move", "set", "bump", "rename", "improve", "show", "hide",
  "allow", "support", "handle", "create", "write", "run", "test", "debug", "review", "ensure", "keep", "stop",
  "start", "try", "find", "figure", "build", "ship", "land", "merge", "revert", "clean", "tweak", "adjust",
])

function firstLine(raw: string): string {
  return raw.split("\n").map((line) => line.trim()).find(Boolean) ?? ""
}

function stripDecoration(text: string): string {
  let out = text.replace(/^(?:name|title|status)\s*:\s*/i, "").replace(/\s+/g, " ").trim()
  // Quotes and trailing punctuation nest either way round (`"Shell budgets".`, `"Shell budgets."`), so
  // peel until nothing changes.
  for (let previous = ""; previous !== out;) {
    previous = out
    out = out.replace(/^["'`*“”‘’«»]+|["'`*“”‘’«»]+$/g, "").replace(/[.!?,;:]+$/g, "").trim()
  }
  return out
}

/** Sentence case that survives identifiers: the first word gets a capital only if it is a plain
 *  lowercase word ("zod" → "Zod", but `z.properties` and "ArkType" stay as written), and a later word
 *  in plain Title case is lowered UNLESS the request itself capitalizes it — "Shell Budget" is drift,
 *  "Focus mode for ntwine" is a proper noun. */
export function sentenceCaseName(name: string, source: string): string {
  return name.split(" ").map((word, index) => {
    if (index === 0) return /^[a-z]+$/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word
    if (/^[A-Z][a-z]+$/.test(word) && !new RegExp(`(^|[^\\p{L}])${word}(?![\\p{L}])`, "u").test(source)) return word.toLowerCase()
    return word
  }).join(" ")
}

/** Why `name` cannot be a thread name — "is longer than two words", or a handle too long to type — or
 *  undefined when it can. Every writer but a human rename holds a name to this. */
export function threadNameProblem(name: string): string | undefined {
  if (name.trim().split(/\s+/).length > THREAD_NAME_MAX_WORDS) return "is longer than two words"
  const handle = threadHandle(name)
  if (handle && handle.length > THREAD_HANDLE_MAX_CHARS) {
    return `is too long to type: its handle @${handle} is ${handle.length} characters, past the limit of ${THREAD_HANDLE_MAX_CHARS}`
  }
  return undefined
}

/** A model's answer as a name, or undefined when it is not one (empty, more than two words, or a handle
 *  past THREAD_HANDLE_MAX_CHARS). */
export function cleanThreadName(raw: string, source = ""): string | undefined {
  const name = stripDecoration(firstLine(raw))
  if (!name || !foldThreadName(name)) return undefined
  if (threadNameProblem(name)) return undefined
  return sentenceCaseName(name, source)
}

/** A model's answer as a status line, clamped. */
export function cleanThreadStatus(raw: string): string | undefined {
  const status = stripDecoration(firstLine(raw))
  if (!status) return undefined
  if (status.length <= THREAD_STATUS_MAX_CHARS) return status
  const cut = status.slice(0, THREAD_STATUS_MAX_CHARS - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > THREAD_STATUS_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function significantWords(source: string): string[] {
  const words: string[] = []
  const seen = new Set<string>()
  for (const raw of source.split(/\s+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    const key = word.toLowerCase()
    if (word.length < 3 || !/\p{L}/u.test(word) || STOP_WORDS.has(key) || seen.has(key)) continue
    seen.add(key)
    words.push(/^[A-Z][a-z]+$/.test(word) ? key : word)
  }
  return words
}

/** The last resort when the model will not produce a free name: keep the name's lead word and give it a
 *  SECOND word from the request that sets it apart ("Shell budgets" taken → "Shell defaults"), and only
 *  when the request has no such word left, a number. Always returns a name `isTaken` refuses. */
export function distinguishingName(name: string, source: string, isTaken: (candidate: string) => boolean): string {
  const clean = stripDecoration(name) || "Thread"
  if (!isTaken(clean)) return clean
  // Words, not whitespace runs: a model's `shell-budgets` leads with "shell", not the whole token.
  const words = clean.split(/[\s_-]+/).filter(Boolean)
  const head = words[0] ?? "Thread"
  const used = new Set(words.map(foldThreadName))
  for (const word of significantWords(source)) {
    if (used.has(foldThreadName(word))) continue
    const candidate = sentenceCaseName(`${head} ${word}`, source)
    if (!threadNameProblem(candidate) && !isTaken(candidate)) return candidate
  }
  for (let n = 2; ; n++) {
    const candidate = `${clean} ${n}`
    if (!isTaken(candidate)) return candidate
  }
}

/** A name from the request alone, for when the model returned nothing usable twice. */
function nameFromSource(source: string): string {
  const words: string[] = []
  for (const word of significantWords(source)) {
    if (words.length === THREAD_NAME_MAX_WORDS) break
    if (!threadNameProblem([...words, word].join(" "))) words.push(word)
  }
  return words.length ? sentenceCaseName(words.join(" "), source) : "Thread"
}

export interface ThreadNamerDeps {
  storage: Pick<Storage, "allSessions" | "setMintedTitle">
  /** The open threads of every OTHER project this server has open (`openThreadsElsewhere`) — names are
   *  unique across all of them (see the header). Absent ⇒ this project alone. */
  elsewhere?: () => readonly NamedThread[]
  /** The model. Absent ⇒ uniqueness still holds for every writer, but nothing is minted. */
  complete?: ClaudeOneShot
  /** A persisted name changed; refresh the board. */
  onNamed?: () => void
  log?: (message: string) => void
}

export interface ThreadNamer {
  /** Whether a model is wired — the mint and the AI rename need one; uniqueness does not. */
  readonly available: boolean
  /** This project's threads — what a handle resolves against first. */
  threads(): NamedThread[]
  /** The open thread, in any open project, other than `exceptSlug` here, already carrying `name`. */
  holder(name: string, exceptSlug?: string): NamedThread | undefined
  /** The taken names a naming prompt lists (open in any project, then recently done here; capped). */
  promptNames(exceptSlug?: string): string[]
  /** `name` if it is free and not a handle `source` mentions, else the distinguishing fallback. */
  distinct(name: string, source: string, exceptSlug?: string): string
  /** Ask the model for a distinct name: once, again naming the collision, then the fallback. A handle
   *  the request @-mentions counts as taken. Throws when no model is wired or it fails outright. */
  name(source: string, exceptSlug?: string): Promise<string>
  /** Fire-and-forget: mint a fresh dispatch's name and persist it, unless something already named the
   *  thread. Mints are SERIAL, so the second of two near-identical dispatches is asked with the first's
   *  name already in its taken list — the model then picks a distinct name itself rather than colliding
   *  and falling back. Resolves when this mint is settled (tests await it). */
  mint(slug: string, sessionId: string, source: string): Promise<void>
  /** Resolves once `slug`'s mint (if one is pending) has settled, at once when none is. `spawn_thread`
   *  waits on it so the caller is handed the new thread's `@handle` rather than a link to a slug. */
  named(slug: string): Promise<void>
  /** A status line for a thread from its recent conversation, or undefined. Throws with no model. */
  status(input: { name?: string; conversation: string }): Promise<string | undefined>
}

export function createThreadNamer(deps: ThreadNamerDeps): ThreadNamer {
  const threads = () => projectThreadNames(deps.storage.allSessions())
  const elsewhere = () => deps.elsewhere?.() ?? []
  const holder = (name: string, exceptSlug?: string) => nameHolder(name, threads(), exceptSlug, elsewhere())
  const promptNames = (exceptSlug?: string) => namesForPrompt(threads(), exceptSlug, elsewhere())
  const distinct = (name: string, source: string, exceptSlug?: string) => {
    // One snapshot for every candidate the fallback tries.
    const here = threads()
    const there = elsewhere()
    const mentioned = mentionedHandles(source)
    return distinguishingName(name, source, (candidate) =>
      mentioned.has(handleKey(candidate)) || nameHolder(candidate, here, exceptSlug, there) !== undefined)
  }
  let mintChain: Promise<void> = Promise.resolve()
  const pendingMints = new Map<string, Promise<void>>()

  async function name(source: string, exceptSlug?: string): Promise<string> {
    const complete = deps.complete
    if (!complete) throw new Error("No model is available to name this thread")
    const mentioned = mentionedHandles(source)
    const listed = promptNames(exceptSlug)
    const listedKeys = new Set(listed.map(handleKey))
    const taken = [...listed, ...[...mentioned].filter(([key]) => !listedKeys.has(key)).map(([, handle]) => handle)]
    let rejected: { name: string; reason: string } | undefined
    let lastCandidate: string | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await complete(namingRequest(source, taken, rejected))
      const candidate = cleanThreadName(raw, source)
      if (!candidate) {
        rejected = { name: firstLine(raw).slice(0, 80), reason: threadNameProblem(stripDecoration(firstLine(raw))) ?? "is not a name" }
        continue
      }
      const taker = holder(candidate, exceptSlug)
      const mention = mentioned.get(handleKey(candidate))
      if (!taker && !mention) return candidate
      lastCandidate = candidate
      rejected = taker
        ? { name: candidate, reason: `is already the name of another thread (${taker.name}${taker.project ? ` in ${taker.project}` : ""})` }
        : { name: candidate, reason: `is the handle of another thread the request mentions (@${mention})` }
    }
    return distinct(lastCandidate ?? nameFromSource(source), source, exceptSlug)
  }

  return {
    get available() { return deps.complete !== undefined },
    threads,
    holder,
    promptNames,
    distinct,
    name,
    mint(slug, sessionId, source) {
      const run = mintChain.then(async () => {
        if (!deps.complete) return
        try {
          const minted = await name(source, slug)
          // Re-checked at the WRITE, synchronously with it: whatever landed while the model was
          // answering (a Codex marker, a human rename, another thread's name) is seen here.
          const final = holder(minted, slug) ? distinct(minted, source, slug) : minted
          if (deps.storage.setMintedTitle(slug, sessionId, final)) deps.onNamed?.()
        } catch (error) {
          deps.log?.(`naming ${slug} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
      mintChain = run
      pendingMints.set(slug, run)
      void run.then(() => { if (pendingMints.get(slug) === run) pendingMints.delete(slug) })
      return run
    },
    named: (slug) => pendingMints.get(slug) ?? Promise.resolve(),
    async status({ name: current, conversation }) {
      if (!deps.complete) throw new Error("No model is available to write a status")
      return cleanThreadStatus(await deps.complete(statusRequest(current, conversation)))
    },
  }
}
