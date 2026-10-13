// A THREAD'S NAME IS ALSO ITS HANDLE (David 2026-09-29: "I want the displayed names to also be
// camelCase so its obvious how to refer to them and that they represent ids"). The handle was camelCase
// until 2026-09-30, when the maintainer switched it to KEBAB-case: it is how the names developers already
// type after `#`/`@` are spelled (Slack channels, repos, branches, npm packages, URL slugs — and this
// thread's own slug), it reads as a name rather than a code identifier, and it needs no Shift.
//
// A name is stored as the one or two words it was minted as ("Shell budgets", "ArkType perf") — the
// server's namer, the worker's `title` tool and a human rename all write words — and it is SHOWN as the
// kebab-case handle those words make (`shell-budgets`, `arktype-perf`). What the operator reads on the board
// is therefore exactly what they type after `@` to point one thread at another ("ask @shell-budgets about
// this"), and what a worker passes to `read_thread` / `message_thread`.
//
// Resolution never depends on the casing: a handle is matched by folding case, punctuation and spacing
// away (the server's `foldThreadName`), so `@shellbudgets`, `@shell-budgets` and `@ShellBudgets` all name
// the same thread — so a camelCase handle written before the switch still resolves. Both sides fold the
// handle with its punctuation removed, so `dev-ops` and `devOps` are both the one word "devops" to the
// plural strip (server thread-mentions.ts, web threadMentions.ts `foldHandle`).

// A name's HANDLE is also what the operator TYPES after `@`, so two words are not enough of a bound on
// their own — every writer but a human rename also holds the handle to this length (server
// thread-names.ts `threadNameProblem`): "Spinoff feature scope and UI" went onto the board as
// `@spinoffFeatureScopeAndUi`, 24 characters nobody wants to type even with autocomplete (maintainer
// 2026-09-29). The cap was sixteen for camelCase; each kebab hyphen spends a character the camel hump did
// not, so it rose to twenty with the switch — enough for every good name on the board that day
// (`background-shells`, 17) while `spinoff-feature-scope-and-ui` (28) is still refused.
export const THREAD_HANDLE_MAX_CHARS = 20

/** Past this many words a stored title is not a name but a sentence (a legacy row, a long human rename),
 *  and a hyphenated run of it would be unreadable; it stays as written and has no handle. Ntwine mints one
 *  or two words, but the name SHOWN can be Claude's own session title until then, and that runs to four
 *  or five ("Test fixture secret word" — seen on a real dispatch, 2026-09-29); those still need a handle
 *  that matches what the board shows. */
const HANDLE_MAX_WORDS = 5

function words(name: string): string[] {
  return name.normalize("NFKD").replace(/\p{M}+/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** The kebab-case handle a name is shown and addressed as, or undefined when the name is too long to be
 *  one: its words lowercased and joined by `-` ("ArkType perf" → `arktype-perf`). A word is never split
 *  at its capitals — that would turn "ArkType" into `ark-type` and "GitHub" into `git-hub`. */
export function threadHandle(name: string): string | undefined {
  const parts = words(name)
  if (parts.length === 0 || parts.length > HANDLE_MAX_WORDS) return undefined
  return parts.map((w) => w.toLowerCase()).join("-")
}

// A SUB-AGENT IS ADDRESSED UNDER ITS THREAD (David 2026-09-30: "subagents accessible as
// `topLevel.subagent` and given name ids with the same prompting as the top-level threads"). A child's
// name is its dispatch `description` (a Workflow agent's, its `label`), and the worker is prompted to
// write it the way a thread's name is written — one or two words naming its subject — so it becomes a
// handle by the same rule: "Cache keys" under `port-the-parser` is `port-the-parser.cache-keys`, and a
// Workflow's agents sit one segment further down. The address is what the board shows in a sub-agent's
// drawer header, what the `@` typeahead completes, and what `read_thread` resolves.
//
// A child whose description is a sentence (six words or more — a worker that did not follow the prompt,
// or one dispatched before it existed) has no handle, exactly as a sentence-length thread title has
// none: it shows as written and is left out of the typeahead.
export const SUB_AGENT_SEPARATOR = "."

/** A sub-agent's handle: its dispatch name, kebab-cased by the thread rule, or undefined for a sentence. */
export function subAgentHandle(label: string): string | undefined {
  return threadHandle(label)
}

/** The handles a `thread.subAgent` address names, outermost first, without the `@`. */
export function addressSegments(address: string): string[] {
  return address.trim().replace(/^@/, "").split(SUB_AGENT_SEPARATOR).filter(Boolean)
}

type ChainAgent = { readonly id?: string; readonly label: string; readonly parentId?: string }

/** Each sub-agent's handle from the thread down to `id`, by walking `parentId`: `["wave-2", "impl-w3"]`.
 *  Undefined when a link in the chain has no handle or is not in `agents` (a descendant whose parent has
 *  already returned), since an address with a hole in it would name nothing. */
export function subAgentChain(agents: readonly ChainAgent[], id: string): string[] | undefined {
  const byId = new Map(agents.flatMap((a) => (a.id ? [[a.id, a] as const] : [])))
  const chain: string[] = []
  const seen = new Set<string>()
  let at = byId.get(id)
  while (at) {
    if (seen.has(at.id!)) return undefined
    seen.add(at.id!)
    const handle = subAgentHandle(at.label)
    if (!handle) return undefined
    chain.unshift(handle)
    if (!at.parentId) return chain
    at = byId.get(at.parentId)
  }
  return undefined
}

/** `port-the-parser.cache-keys` — the thread's handle, then each sub-agent's down the dispatch tree. */
export function subAgentAddress(threadHandle: string, chain: readonly string[]): string {
  return [threadHandle, ...chain].join(SUB_AGENT_SEPARATOR)
}

/** One address segment: letters and digits, joined by single `-` or `_`, never ending on one — so a
 *  dash written straight after a mention ("@shell-budgets- then…") is punctuation, not part of it. */
export const HANDLE_SEGMENT = String.raw`[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*`

/** `@handle` mentions in free text, in order, without the `@`. A mention starts at a word boundary (so an
 *  email address is not one) and runs over HANDLE_SEGMENTs, on through a `.` that is followed by another
 *  segment (`@port-the-parser.cache-keys`) — so a sentence's full stop after a mention is never part of it. */
export function threadMentions(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(new RegExp(String.raw`(?:^|[^\p{L}\p{N}_@./])@(${HANDLE_SEGMENT}(?:\.${HANDLE_SEGMENT})*)`, "gu"))) out.push(m[1]!)
  return out
}

// A REPLY WAIT (`message_thread` with `await_reply`) is an ordinary one-off TIMER on the asker whose prompt
// names the thread it waits on. The prompt is also its NAME wherever a timer is listed, so it reads as the
// wait; the `(thread \`slug\`)` tail is what the answer is matched by (a handle can change with a rename, a
// slug cannot). The format and its reader live together here because both sides read it: the server
// matches the answer and checks a fence's `threads:` against it, and the resting card rows it as a thread.
const REPLY_WAIT_RE = /^Waiting on @(\S+) to reply \(thread `([^`]+)`(?: in ([^)]+))?\)/

/** A wait on a thread in ANOTHER project names that project too: slugs are unique only within one, so an
 *  answer from a same-slug thread here must not settle a wait on the other project's. */
function replyWaitRef(slug: string, project?: string): string {
  return project ? `thread \`${slug}\` in ${project}` : `thread \`${slug}\``
}

export function replyWaitPrompt(handle: string, slug: string, project?: string): string {
  return (
    // Read in two places: as the wait's name while it stands, and as the wake if it fires — so the first
    // sentence is the wait and the rest is conditional on it having run out.
    `Waiting on @${handle} to reply (${replyWaitRef(slug, project)}). If this fires, no answer came in time: read where it is ` +
    "with `ntwinectl read-thread`, then ask again with `ntwinectl message-thread … --await-reply` if " +
    "the answer still matters, or go on without it."
  )
}

/** The thread a timer's prompt waits on, or undefined for any other timer. */
export function replyWaitOf(prompt: string): { handle: string; slug: string; project?: string } | undefined {
  const m = REPLY_WAIT_RE.exec(prompt)
  return m ? { handle: m[1], slug: m[2], ...(m[3] ? { project: m[3] } : {}) } : undefined
}

/** Is this timer a reply wait on that thread? */
export function isReplyWaitFor(prompt: string, slug: string, project?: string): boolean {
  const wait = replyWaitOf(prompt)
  return wait !== undefined && wait.slug === slug && wait.project === project
}
