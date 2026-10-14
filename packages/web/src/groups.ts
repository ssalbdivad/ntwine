import {
  atRest,
  doneButRunning,
  futureSnoozedUntil,
  hasLiveOps,
  hasLiveSubAgents,
  inActiveBand,
  isActivelyRunning,
  isDeclaredAwaiting,
  isSnoozed,
  prChecksRunning,
  needsAction,
  queuedThread,
  sectionOf,
  subAgentAddress,
  subAgentChain,
  subAgentHandle,
  threadHandle,
  type AwaitingHint,
  type SectionKey,
  type ThreadView,
} from "@ntwine/shared"

// The band predicates live in @ntwine/shared so the server counts the rail's running badge with the
// same rule the sidebar bands on. Re-exported here, where every web caller already imports them.
// `needsAction` (the queue's ask definition) moved there too, so the server can count a project's asks.
export { doneButRunning, futureSnoozedUntil, isActivelyRunning, isSnoozed, needsAction, prChecksRunning, sectionOf, type SectionKey }
import { canRetry } from "./lib/status.ts"

// Shared listing logic: the queue definition (needsAction), the sidebar's status-keyed sections
// (sectionThreads), and the interaction-recency ordering both surfaces use.

type TitleFields = Pick<ThreadView, "title" | "aiTitle" | "id" | "titleAuto" | "titleLocked" | "titleNamed" | "spawnedAt" | "backend" | "runtime" | "foreign" | "held">

// The title to SHOW for a thread: its HANDLE. A real name ("Shell budgets") renders as the kebab-case
// handle it makes (`shell-budgets`, @ntwine/shared thread-handle.ts), so what the operator reads on the
// board is exactly what they type after `@` to point one thread at another (David 2026-09-29: "I
// want the displayed names to also be camelCase so its obvious how to refer to them and that they
// represent ids"; kebab-case since 2026-09-30). Everything that is NOT a name renders as it always did: the "Spinning up…" and
// "Untitled thread" placeholders, a legacy row's bare id, an external terminal session's resolved
// title (Ntwine holds no registry name for it, so there is nothing to address), and a name too long to
// be a handle (a legacy sentence-length title — threadHandle declines past five words).
//
// One place so every render site (sidebar, palette, header, drawer, tab title) agrees. The narrow Pick
// accepts a valtio readonly snapshot as readily as a plain ThreadView.
export function displayTitle(t: TitleFields): string {
  const source = titleSource(t)
  return source.name ? threadHandle(source.text) ?? source.text : source.text
}

// The thread's name in the WORDS it is stored as ("Shell budgets") — what a rename edits, since a human
// rename writes words and the handle is derived from them. Same provenance rules as displayTitle; only
// the final kebab-case step is skipped. Also what a search should match alongside the handle, so typing
// "shell bud" still finds `shell-budgets`.
export function displayName(t: TitleFields): string {
  return titleSource(t).text
}

// The `@` handle a thread can be addressed by, or undefined when what it shows is not a name (a
// placeholder, an id, an external row) or is too long to be one. The mention typeahead offers exactly
// the threads this returns a handle for.
export function threadHandleOf(t: TitleFields): string | undefined {
  const source = titleSource(t)
  return source.name ? threadHandle(source.text) : undefined
}

// A SUB-AGENT'S NAME, SHOWN AS ITS HANDLE — the same rule as a thread's (David 2026-09-30:
// "subagents accessible as `topLevel.subagent` and given name ids with the same prompting as the
// top-level threads"). Its dispatch name ("Cache keys") reads as `cache-keys` on every row that shows a
// child as ITSELF — the rail, the queue card, the ops strip, the wait rail, a Workflow's tree, the
// transcript's dividers — so what the operator reads under a thread is the segment they type after
// `@thread.`. A sentence-length name (a worker that ignored the prompt, or one dispatched before it
// existed) has no handle and shows as written, exactly as a sentence-length thread title does.
export function subAgentName(label: string): string {
  return subAgentHandle(label) ?? label
}

// The full `thread.child` address of one of a thread's LIVE sub-agents, from the board alone
// (`port-the-parser.wave-2.impl-w3`), or undefined when the thread has no handle or a link in the chain has
// none or has already returned. The drawer header's first choice; a finished child's address comes from
// the server's `subAgentDirectory` instead, which still has the whole tree on disk.
export function subAgentAddressOf(t: TitleFields & Pick<ThreadView, "subAgents">, subId: string): string | undefined {
  const head = threadHandleOf(t)
  if (!head) return undefined
  const chain = subAgentChain(t.subAgents ?? [], subId)
  return chain ? subAgentAddress(head, chain) : undefined
}

// The title a drawer passes for a child it cannot name (a report whose sender's description had not
// resolved, ChatView SubAgentReportLine). A stand-in, not a name, so it never becomes the handle `sub-agent`.
export const UNNAMED_SUB_AGENT_LABEL = "Sub-agent"

// The SUB-AGENT DRAWER'S HEADER: the child's whole address (`port-the-parser.cache-keys`) — what the
// operator types to point another thread at it — when the live board resolves it; else one the
// directory already told this page (`known`, a returned child opened from a `@` mention); else its
// handle alone; else its label as written.
export function subAgentTitle(
  t: (TitleFields & Pick<ThreadView, "subAgents">) | undefined,
  subId: string,
  label: string,
  known?: readonly { readonly id: string; readonly address?: string }[],
): string {
  const address = (t && subAgentAddressOf(t, subId)) ?? known?.find((entry) => entry.id === subId)?.address
  if (address) return address
  return label === UNNAMED_SUB_AGENT_LABEL ? label : subAgentName(label)
}

// Where the shown title comes from, and whether it is a real NAME (which displays as its handle) or a
// stand-in for one (a placeholder, an id, an external row's resolved title), which displays verbatim.
function titleSource(t: TitleFields): { text: string; name: boolean } {
  // An EXTERNAL row is already named. The server resolves it in foreignThreadView — the harness's own
  // name, else a chop of the opening human turn, else a short id — which is the order both agents'
  // resume pickers use, and it stores the result in `title`. Every rule below is about a row ntwine
  // DISPATCHED: a placeholder for a name that is on its way, a raw prompt ntwine seeded and must never
  // show. Neither describes a terminal session, and the codex rule in particular replaced every
  // external codex row's resolved name with "Untitled thread" the day the server learned to name them
  // (maintainer 2026-08-24: "for my externals all the codexes show up as 'untitled thread'").
  if (t.foreign === true && t.title.trim()) return { text: t.title.trim(), name: false }
  // A machine-guessed dispatch title (titleAuto) with no aiTitle yet is NOT a real name — show the
  // "Spinning up…" placeholder while the session is genuinely just spinning up (maintainer 2026-07-10:
  // "do not try to guess at the thread title"). But that's BOUNDED (see titleIsProvisional): a session
  // Claude that never yields an aiTitle falls back after its bounded window; Codex gets a shorter
  // grace and then the neutral fallback below.
  if (titleIsProvisional(t)) return { text: SPINNING_UP_TITLE, name: false }
  // The worker's OWN name for its task wins over whatever the row was seeded with — unless a human has
  // claimed the name, in which case a stale/slug-shaped backend record must never displace it.
  // Only a persisted name is a NAME (shown as a handle): with `titleNamed` false, aiTitle is Claude's live
  // session title, which moves — and a handle never changes once shown — so it reads as plain text.
  if (t.aiTitle?.trim() && !titleIsHumanOwned(t)) return { text: readableMachineTitle(t.aiTitle), name: t.titleNamed !== false }
  // Codex's TUI has no native automatic naming event. Ntwine asks the first finalized response for a
  // hidden title signal; omission or malformed syntax must stay neutral rather than exposing either
  // the stored legacy prompt heuristic or a provider-recorded raw initial prompt.
  if (t.backend === "codex" && t.titleAuto === true && !t.aiTitle?.trim()) return { text: UNTITLED_THREAD_TITLE, name: false }
  // `titleAuto === false` means the stored title is a real name, not the prompt chop — a human rename,
  // or a caller's dispatch title standing in until the worker names the thread itself. Unknown legacy
  // rows retain the historical aiTitle-first fallback because their provenance is unavailable.
  if (t.titleAuto === false && t.title.trim()) return { text: t.title.trim(), name: true }
  // For machine-titled rows, an internal slug is not a display title. This is especially important
  // around native `/rename`: if Claude fails to emit a custom title, the header must keep a neutral
  // name rather than presenting the session identifier as though rename succeeded. Legacy rows
  // (unknown titleAuto) retain the historical id fallback.
  if (t.title.trim() && !(t.titleAuto === true && t.title.trim() === t.id)) {
    return { text: t.titleAuto === true ? readableMachineTitle(t.title) : t.title.trim(), name: t.titleNamed !== false }
  }
  return { text: t.titleAuto === true ? UNTITLED_THREAD_TITLE : t.id, name: false }
}

// Has a HUMAN claimed this thread's name? The server withholds aiTitle from any NAMED row (titleNamed),
// so this now only guards a legacy/slim row that carries no `titleNamed`. Mirrors the server's `sessionTitleLocked` exactly, including its fallback: a row with no
// `titleLocked` predates the split, so any non-guessed title there is read as the human's. That
// fallback is what keeps a legacy rename safe, and what makes `titleLocked: false` — written only by a
// dispatch whose title a CALLER hard-coded — the sole way a real-looking title stays replaceable.
function titleIsHumanOwned(t: Pick<ThreadView, "titleAuto" | "titleLocked">): boolean {
  return t.titleLocked ?? t.titleAuto === false
}

// Backend-generated titles are not human metadata. Claude's native auto-rename currently reports a
// semantic kebab slug; humanize that immediately so even the short generate→confirm interval can
// never paint an internal identifier. Explicit/manual titles bypass this helper above and stay exact.
// SENTENCE case (capitalize only the first word) — thread titles follow the repo copy rule (see
// AGENTS.md), never Title Case; mirrors the server's humanizeClaudeTitle so the generate→confirm
// interval and the persisted rename read identically.
export function readableMachineTitle(raw: string): string {
  const title = raw.trim()
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(title)) return title
  const words = title.split(/[-_]+/).filter(Boolean)
  if (words.length === 0) return title
  const joined = words.join(" ").toLowerCase()
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

// The placeholder shown (dimmed) while a freshly-dispatched thread has only a machine-guessed title.
export const SPINNING_UP_TITLE = "Spinning up a thread…"
export const UNTITLED_THREAD_TITLE = "Untitled thread"

// Both backends are bounded by a TIME window — Codex's is shorter because its title signal rides the
// first finalized response rather than a separate naming event. (This once read "Codex uses its
// concrete spawning runtime state"; nothing ever emitted that state. See titleIsProvisional.)
const SPIN_UP_MS = 60_000
const CODEX_TITLE_SIGNAL_GRACE_MS = 15_000

// A title is PROVISIONAL when it's the auto-guessed dispatch slug, Claude hasn't named the session yet
// (titleAuto && no aiTitle), AND the dispatch is still WITHIN the spin-up window. The time bound is
// load-bearing: a long session that compacts gets a NEW transcript id, so ntwine (still tracking the
// pinned id) loses the transcript and never sees an aiTitle — without the bound the row would stick on
// "Spinning up…" forever (maintainer 2026-07-10). After the window it falls back to the dispatch title.
// Root cause of the lost transcript is tracked separately ([[session-transcript-drift]]).
export function titleIsProvisional(t: Pick<ThreadView, "aiTitle" | "titleAuto" | "titleNamed" | "spawnedAt" | "backend" | "runtime" | "held">): boolean {
  // A HELD thread is not spinning up. No agent has run for it and none is starting: it waits for a message
  // to start it — a schedule's run time or, for an orphan whose holder is gone, the human's. Its spawn time is when it was WRITTEN DOWN, so the window below read a held thread as
  // "Spinning up a thread…" for its first minute, on the queue card, the drawer, the rail and the phone,
  // while the drawer under that title said "Not started yet." (QA 2026-10-06). `held` alone is
  // the test, whoever the holder: the row reads from its first render as it reads after the minute — its
  // prompt's guess, as plain text, until a message starts it and the window applies to the real start.
  if (t.held !== undefined) return false
  // A live session title that is not a name yet does not end the placeholder: the minted name is seconds
  // behind it, and showing the session title first would put one text on the card and then another.
  if (!t.titleAuto || (t.titleNamed ?? Boolean(t.aiTitle))) return false
  // Codex now emits its title in the first assistant commentary, normally a couple seconds after the
  // rollout starts. Keep the neutral startup label through that short, bounded title-signal grace so
  // the row never flashes "Untitled thread" between task_started and the comment. A noncompliant or
  // failed worker still degrades to the neutral fallback after the grace; it can never stick here.
  if (t.backend === "codex") {
    // DEAD BRANCH, kept deliberately. `deriveRuntime` (board.ts) has no `"spawning"` return — the
    // state is on the wire enum and nothing emits it — so the grace below is what actually bounds a
    // codex row, and a dispatch whose title signal lands after it flashes "Untitled thread". Waking
    // this branch means making the server emit `spawning`, which changes what every other reader of
    // `runtime` sees; it is not a comment fix. Left as the honest record of the intended shape.
    if (t.runtime === "spawning") return true
    const spawned = Date.parse(t.spawnedAt ?? "")
    return Number.isFinite(spawned) && Date.now() - spawned < CODEX_TITLE_SIGNAL_GRACE_MS
  }
  const spawned = Date.parse(t.spawnedAt ?? "")
  return Number.isFinite(spawned) && Date.now() - spawned < SPIN_UP_MS
}

// USER-INTERACTION key (ms): the newest REAL USER INTERACTION on the thread — an answer, a steer, or
// the dispatch itself — falling back to spawn time when there's been no later interaction (a dispatch
// IS an interaction). `lastUserAt` is server-derived to EXCLUDE tool_results, so it never moves from
// AGENT motion. This is the stable base folded into `lastActiveAt` below (and the churn-free fallback
// a still-running row uses). Neither timestamp present → 0 (sinks to the bottom, id-tiebroken).
function interactionAt(t: ThreadView): number {
  const u = Date.parse(t.lastUserAt ?? "")
  const s = Date.parse(t.spawnedAt ?? "")
  const max = Math.max(Number.isFinite(u) ? u : -Infinity, Number.isFinite(s) ? s : -Infinity)
  return Number.isFinite(max) ? max : 0
}

// The at-rest LISTING key — every list but the queue, which orders by when a thread ENTERED it
// (orderQueue) and falls back to this only for a row that predates that stamp. "Last active" = when the
// thread's OWN agent last came to REST — its
// `lastAssistantAt` (last assistant output). NOT `lastActivityAt`: that is bumped by a background
// sub-agent's completion notification (a promptSource:system record) and by tool_results, so keying on
// it let a CHILD finishing reshuffle the parent (maintainer 2026-07-16: "it should just be based on
// when the agent rested … user turns don't actually factor in"). User turns don't factor in either:
// a steer flips the thread to running, and only its next REST re-times it. A RUNNING row is not in the
// queue/rested band — it belongs to the active rail, ordered by user recency — so it keeps
// `interactionAt` (max lastUserAt/spawnedAt), which also guards against mid-turn churn. Missing rest
// time (never produced output yet) → `interactionAt` (spawn/last-user). `isActivelyRunning` is hoisted.
function lastActiveAt(t: ThreadView): number {
  if (isActivelyRunning(t)) return interactionAt(t)
  const rest = Date.parse(t.lastAssistantAt ?? "")
  return Number.isFinite(rest) ? rest : interactionAt(t)
}

// The timestamp the "Last active" label should DISPLAY. A RUNNING row shows its live activity
// (`lastActivityAt` — "just now" while it works); an AT-REST row shows its rest time (`lastAssistantAt`),
// so a background sub-agent completing can never flip a rested row's label to "just now". Falls back to
// lastActivityAt then spawn when a backend never recorded the rest instant (legacy/foreign rows). The
// queue's own column prints `queueLabelAt` instead, which is this for every plain rest.
export function lastActiveLabelAt(t: Pick<ThreadView, "runtime" | "lastActivityAt" | "lastAssistantAt" | "spawnedAt" | "subAgents" | "bgShells">): string | undefined {
  if (isActivelyRunning(t as ThreadView)) return t.lastActivityAt ?? t.spawnedAt
  return t.lastAssistantAt ?? t.lastActivityAt ?? t.spawnedAt
}

// The listing DIRECTION the queue/rested band orders by (a per-browser view preference — see
// lib/prefs.ts). FIFO (default) surfaces the longest-waiting item first so the human cycles through
// all work; LIFO surfaces the most recent arrival first.
export type QueueDirection = "fifo" | "lifo"

// Attention first (needsAction), then most-recent LAST-ACTIVE first within each band (see
// lastActiveAt). id-tiebroken so equal-time rows hold a stable order. New array; input untouched.
export function sortThreads(threads: readonly ThreadView[]): ThreadView[] {
  return [...threads].sort((a, b) => {
    const aa = needsAction(a)
    const bb = needsAction(b)
    if (aa !== bb) return aa ? -1 : 1
    const d = lastActiveAt(b) - lastActiveAt(a)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
}

// Order a thread set by most-recent LAST-ACTIVE first (lastActiveAt), id-tiebroken. Used for the
// running band and the Snoozed/Inactive sections — surfaces where newest-on-top is always wanted (the
// FIFO/LIFO preference governs only the queue/rested band via orderQueue). A running row keys off its
// stable user-interaction time (lastActiveAt's churn guard), so live agent motion never reshuffles it;
// an at-rest row keys off when it came to rest, matching its "Last active" label. New array; input
// untouched.
export function orderByInteraction(threads: readonly ThreadView[]): ThreadView[] {
  // Keys read ONCE per thread, not twice per comparison: these are valtio snapshot proxies, where every
  // property read is tracked, and lastActiveAt parses dates — inside the comparator that was O(n log n)
  // of both (1.2s of a 20s page profile on a 440-thread mirror, 2026-10-01).
  const keyed = threads.map((t) => ({ t, at: lastActiveAt(t), id: t.id }))
  keyed.sort((a, b) => {
    const d = b.at - a.at
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
  return keyed.map((k) => k.t)
}

// The queue is a SINGLE strictly time-ordered list — no priority band. Every waiting card orders by
// DIRECTION (a per-browser view preference — see lib/prefs.ts) alone, so the visible "oldest first"
// rule is literally true across every card, attention and passive alike (maintainer 2026-07-21:
// removed the hidden hard-attention band — "too confusing"; a fresh crash/permission-prompt no longer
// floats above an older done card):
//   • FIFO (default): the thread that has been IN THE QUEUE longest surfaces first, so answering it
//     sends it to the BACK of the line and the next-oldest rises — the human cycles through every
//     waiting item instead of endlessly re-triaging whatever rested most recently (maintainer
//     2026-07-15: "first in first out is a better system… you are not constantly cycling through all
//     of the tasks").
//   • LIFO: the most recent arrival first (descending) — the older last-in-first-out feel.
// THE KEY IS WHEN IT ENTERED THE QUEUE (`queuedAt`, stamped by the server's queue clock), not when its
// agent last spoke. The two agree for a plain rest and nothing else: a thread that rested behind a wait
// — CI, a sub-agent, a park, a snooze — enters when the wait lets go, and keyed on its old rest time it
// cut in at the FRONT, above the card the human was reading (maintainer 2026-09-24: "when a new thread
// is ready, it moves to the top of the *stack* … make it work like an actual queue"). A new arrival now
// always joins the back, and nothing moves a thread while it waits. `queueKeyAt` falls back to the rest
// time only for a row from a server that predates the stamp.
// Equal entries (several snoozes elapsing in one assembly) fall back to rest order, then id, so a tie
// holds a stable order.
export function orderQueue(threads: readonly ThreadView[], direction: QueueDirection = "fifo"): ThreadView[] {
  const dir = direction === "lifo" ? -1 : 1
  return [...threads].sort((a, b) => {
    const age = (queueKeyAt(a) - queueKeyAt(b)) * dir || (lastActiveAt(a) - lastActiveAt(b)) * dir
    return age !== 0 ? age : a.id.localeCompare(b.id)
  })
}

function queueKeyAt(t: ThreadView): number {
  const queued = Date.parse(t.queuedAt ?? "")
  return Number.isFinite(queued) ? queued : lastActiveAt(t)
}

// The timestamp a QUEUE surface prints beside a waiting thread — the cue's right-hand column, the queue
// card's time line — kept in lockstep with `orderQueue`'s key so the column reads monotonically down
// the line it is printed in (maintainer 2026-08-08). For a plain rest it is the rest time exactly; for
// a thread that entered off a wait it is how long it has been waiting on the human. Surfaces that are
// not the queue (the conversation header) keep `lastActiveLabelAt`, the agent's own rest.
export function queueLabelAt(t: Pick<ThreadView, "queuedAt" | "runtime" | "lastActivityAt" | "lastAssistantAt" | "spawnedAt" | "subAgents" | "bgShells">): string | undefined {
  return t.queuedAt ?? lastActiveLabelAt(t)
}

// The word a queue CARD puts in front of that time. "Last active" would be false for a thread that
// entered off a wait — its agent may last have spoken hours before it came to the human — so a queued
// card says how long it has been READY, the name its band wears (7f840a59). A card for a thread that is
// not queued (none on the queue surfaces today) keeps saying what its time is.
export function queueLabelWord(t: Pick<ThreadView, "queuedAt" | "queuedForReply">): string {
  // A park in the queue only for its unread reply says so: "Ready" over an Awaiting card read as a
  // wait the human was somehow supposed to act on (board.ts queuedForReply).
  if (t.queuedAt && t.queuedForReply) return "Replied"
  return t.queuedAt ? "Ready" : "Last active"
}

// ── SESSION-FIRST QUEUE ──────────────────────────────────────────────────────────────────────────
// The Needs-you queue (the cards surface) is EXACTLY the session threads the SERVER derived as needing
// the human (t.needsYou — explicit questions, checked/done handoffs, and process-level blocks a view
// can't clear). Do NOT re-derive it client-side for session rows. Legacy .ntwine-file rows
// never card anymore. An archived thread is out of the queue regardless (belt-and-suspenders — the
// server already drops needsYou when archived). Pre-restart snapshots carry no kind/needsYou → false →
// an empty queue, the accepted degrade.
export function queued(t: ThreadView): boolean {
  // Foreign (terminal-originated) sessions never queue: their interaction surface is the terminal
  // the human is already sitting in — ntwine can't be "awaiting" them here. The predicate itself is
  // shared with the server, which counts it per project for the rail's badges.
  return queuedThread(t)
}

// EXTERNAL SESSIONS — agent sessions discovered in the project's transcript dir that ntwine did NOT
// originate (the human's own terminals). They are NOT part of the four ntwine bands and never can be
// while they stay external: such a session writes no ```awaiting fence and has no lifecycle row, so
// Snoozed and Done have nothing to derive from (see the server's foreignThreadView). So they get their
// own collapsible section at the bottom of the rail — one the reader can ignore wholesale.
//
// ONE NAME, TWO SPELLINGS, on purpose. The WIRE field is `foreign`, which is what the tailer has
// called an unregistered transcript since long before this band existed and what the server still
// calls it. Everything the HUMAN sees says EXTERNAL (maintainer 2026-08-24), so the web says external
// too and the boundary between the two vocabularies is exactly this predicate.
//
// The server emits only RESTED ones (maintainer 2026-08-19: a spinning terminal session is one you
// already have open), so this is a plain partition rather than a second opinion about rest. A session
// stops being external the moment you STEER it — the first message promotes it to an ordinary thread.
export function externalThreads(threads: readonly ThreadView[]): ThreadView[] {
  return threads.filter((t) => t.kind === "session" && t.foreign === true)
}

// ── SIDEBAR SECTIONS (session-first) ───────────────────────────────────────────────────────────────
// THE VOCABULARY, because the `"active"` key below does NOT mean what the maintainer means by Active
// (2026-08-05: "when I say active, I'm only referring to the things that are currently spinning; the
// things beneath that I would refer to as rested, or just items in the queue"). Written out in full in
// ARCHITECTURE.md § Board nomenclature; the short form, top of the rail to the bottom:
//   RESTED   — the cue: the same set as "the queue", exactly one row per card. It sits DIRECTLY UNDER
//              THE PROMPT BOX (maintainer 2026-08-08) — what is waiting on the human is what the human
//              came to read, so it gets the rail's best position.
//   ACTIVE   — below the rule, in practice the rows currently SPINNING. Never carries a queue card, and
//              that is the actual rule of the split — see inActiveBand for the rows it also takes.
//   HELD     — the dimmed, labeled park band.
//   DONE     — the collapsed archived section.
// Say "rested" or "in the queue" for a card's row. NEVER call it active merely because this key does.
//
// The rail's THREAD-derived sections, keyed on the session-first model (NOT ntwine status). Every thread
// row lands in exactly one of these.
//   • active           — the SECTION holding the Active AND Rested bands (partitionActive splits it):
//                        open session work — running, needs-you, bare rest, done-fenced, OR owning a
//                        live sub-agent/background shell/Monitor. Never dimmed as a band.
//   • held             — open, AT REST behind ANY declared ```awaiting fence (or the canonical
//                        blocked+timer status) AND no live background op — or behind a rest its worker
//                        called `watching`, live op or not (2026-10-05). Its own DIMMED band between
//                        the rested rows and Done. The glyph and section share isSnoozed(), so a row can
//                        never read as "snoozed" while sitting in the Active/Rested section. (The
//                        hourglass GLYPH is not Snoozed's alone since 2026-09-07: a queued wait on a
//                        timer wears it too — awaitingTimerWatch — the way a queued PR wait wears the
//                        octocat. The band says parked; the mark says what it waits on.)
//   • inactive         — state === "archived" (the only archiver is an explicit Archive / done-card
//                        button) and at rest: an archived thread whose worker is still running lifts
//                        into the Active band until it rests (sectionOf, upstream 2026-07-10). Rendered
//                        under the label DONE — the key and the label differ.
//   • legacy           — kind !== "session": vestigial .ntwine-file rows, hidden entirely (null).
// A FOREIGN session row (a maintainer terminal — no registry row, so no state/needsYou) is dropped
// entirely (never rows). Order within a section is interaction recency.
// Thread-derived buckets, in render order.
export const SECTION_ORDER: readonly SectionKey[] = ["active", "snoozed", "inactive"]

// PINNED — the human lifted this thread out of the band system entirely (maintainer 2026-09-02). Not a
// SectionKey on purpose: sectionOf stays the pure state-derivation it is, and the pin is a human
// override applied ABOVE it (sectionThreads diverts these rows before sectionOf runs), the same
// altitude as the foreign drop. Deliberately ignores state: the pin outranks Done, Snoozed and the
// queue alike — that is the whole feature.
export function isPinned(t: ThreadView): boolean {
  return t.kind === "session" && t.foreign !== true && typeof t.pinnedAt === "string"
}

// The wait kinds that truthfully earn the parked/hourglass presentation. A timer is only a park while
// its valid scheduler instant is still in the future; malformed or elapsed timer prose must not
// advertise a durable future wake. Legacy machine waits (pr/ci/session) intentionally do not qualify.
//
// A PR WAIT IS DELIBERATELY ABSENT: the review/approval/comment watcher must NOT park in Snoozed. A worker
// that opens a PR and watches it stays a VISIBLE queue handoff (a PR whose reviews may never arrive must
// not silently vanish into the dimmed band — maintainer 2026-07-22); the scheduler still polls and bumps
// it, and the human opts into hiding it via the RESTING card's event-snooze, which drops the card until
// the thread comes to a new rest (2026-08-13 — that card is where a parked watcher is now stated and
// controlled; the awaiting card no longer offers a park action for it). Admitting one here would
// re-introduce exactly the auto-Snoozed danger this split was built to remove. (The key is `prs:` since the
// 2026-08-24 YAML cutover; both spellings this paragraph was written against — the singular `pr:`, and the
// `pr-watch:` before it — are retired, see RETIRED_AWAITING_KINDS. The WIRE kind stays singular, which is
// why the code below still reads `hint.kind === "pr"`.)
// NOTHING HERE PARKS A THREAD ANY MORE (2026-08-15). This returned the two hint kinds that dimmed a
// thread into Snoozed on the worker's word alone: `human:`, which NOTHING EVER FIRED, and a future
// `timer: <instant>`, one of which was published 5h55m in the PAST — it parsed, armed nothing, and left
// its thread parked for 5.5 hours. Both kinds are deleted. A park is now a structural declaration the
// SERVER checks against live telemetry and the registries (board.hasDeclaredBackgroundPark), which is
// not something the client can or should re-derive from hints alone.
export function parkedAwaitingHint(_hints: readonly AwaitingHint[], _nowMs = Date.now()): AwaitingHint | undefined {
  return undefined
}

// A QUEUE HANDOFF THAT HAS ALREADY COME TO REST: the server queued it (`needsYou`) and the thread's
// OWN turn is over (turn-idle/exited). It must not make the PARENT's rail mark claim motion the parent
// does not have (maintainer 2026-07-27: "when an agent comes to rest and shows up in the queue, it
// should get the ellipsis indicator in the sidebar, even though its sub-agents are still spinning").
// The children keep their own spinners on the card and in the drawer (ChildOpRow), and a count on the rail row (Sidebar SubAgentCount);
// the parent's indicator speaks for the parent. A queued row therefore sits in the rested band AND
// reads as rested.
//
// From 2026-07-30 the live-SUB-AGENT case did not reach here at all: the server excused such a thread
// from the queue entirely (board.deriveNeedsYou), so `needsYou` was false and the row kept its spinner in
// the running band. That still holds for a thread dispatched before the answer-required cut, and for a
// later one whose fence answers `status: working`. It reaches here AGAIN (2026-10-01) for a worker that
// answers `needs_input` with a child still out, or rests on one with no fence: it asked for the human, so
// it sits in the rested band with this ellipsis, and the child keeps its own spinner on its indented row.
//
// Still load-bearing for the EXITED parent whose children keep reading "running" until their transcript
// goes stale. Without this it would resolve to "working" and hide the [!] stall mark behind a spinner
// for a pane that is already dead. (The other case it used to cover — a shell-only rest, which queues
// again since 2026-08-04 — now has its own mark; see restingOnBackgroundWork, which is checked first
// and gives it the dot rather than this ellipsis.)
function restedQueueHandoff(t: ThreadView): boolean {
  return t.needsYou === true && atRest(t)
}

// RESTING ON BACKGROUND WORK, AND NOTHING ELSE: the thread's own turn is OVER (turn-idle) and the only
// thing it still has out is something it launched or parked on — a background shell/Monitor, or (since
// 2026-08-13) a PR watcher. That earns its own mark — the pulsing blue dot in the rail's rounded box
// (maintainer 2026-08-01: "if a thread has rested but it still has background work going, like
// background shells, we should keep it in the actively running rail, but we should stop the spinner and
// put a pulsing blue dot in the middle of the rounded circle shape").
//
// The MARK outlived the band. Since 2026-08-04 such a thread carries a queue card again (maintainer:
// "if a thread has rested and the only thing remaining is background shells, we should put it into the
// queue"), so `needsYou` drops its row below the rule into the rested band — and the dot stays, because
// it is the one thing that tells that row apart from an ordinary bare rest at a glance. Snoozing the
// card parks it in the dimmed Snoozed band (isSnoozed reads `bgSnoozed`). Until 2026-08-28 the snooze
// sent it back to the running band with the same dot — "still alive, no longer asking" — and the
// maintainer read that as a row the snooze had not touched at all.
//
// A LIVE SUB-AGENT IS DELIBERATELY EXCLUDED (maintainer, same day: "this should not show up if there
// are sub-agents"), and the two are genuinely different states rather than two flavours of one. A
// dispatched child is work the parent is WAITING ON: its return re-invokes the parent within seconds,
// so the thread is mid-flight in substance even though its own turn ended, and the spinner tells the
// truth. A background shell is DETACHED — the worker launched it and moved on, and 26% of real launches
// are servers that never exit — so nothing about that thread is in motion. Hence: spinner while
// something will come back to you, dot while something merely runs on. A thread with BOTH keeps the
// spinner, because the sub-agent is the stronger fact.
//
// Gated on `turn-idle`, never `exited`: a dead pane cannot be waiting on anything, and that parent must
// keep its [!] stall mark rather than advertise live work behind a dot. `awaitingBackground` is server
// truth — see hasLiveOps for why a raw `bgShells` read would be wrong. (It once ALSO excluded every
// fenced thread, which is no longer so: a parked PR watch, a declared background park and an armed timer
// each set it on an ```awaiting fence. Nothing here depended on that; hasLiveOps did.)
//
// This is only HALF the dot's gate: whether any of that work is still MOVING is the next question, and
// `restingOnLiveBackgroundWork` below answers it. The broad reading survives here because the `working`
// branch needs it — a thread at rest behind its own declared work must never spin, moving or not.
function restingOnBackgroundWork(t: ThreadView): boolean {
  return t.runtime === "turn-idle" && t.awaitingBackground === true && !hasLiveSubAgents(t)
}

// …AND IS ANY OF IT ACTUALLY MOVING? The dot says "alive, not moving"; it must never say that about a
// thread where nothing is running at all. A registered PR watcher joined `awaitingBackground` on
// 2026-08-13 (it earns the resting card and that card's snooze), and it brought a shape a shell never
// has: a wait whose subject has ALREADY FINISHED. A green PR is not background work in flight — it is a
// handoff sitting on the human's merge, and the row wore the same live blue dot as a running dev server
// (maintainer 2026-08-19, on an ```awaiting fence naming a PR — `pr:` in the grammar of that day, `prs:`
// since 2026-08-24 — whose card read "10 successful · no
// conflicts": "this task should not be listed as in the actively running rail if it's only awaiting a PR
// with green CI").
//
// So the dot needs motion, and this is the SAME rule the band already draws server-side — CI still
// running holds the thread out of the queue (board.heldByRunningChecks, maintainer 2026-08-14: "only if
// CI has failed or completed successfully should it show up back in the queue"). The mark simply never
// got it, so the two disagreed about one thread: banded as a handoff, marked as live work.
//
// ANY watched PR still running counts, where the band's excusal needs ALL of them. The two questions are
// different: the band asks "is there anything for the human to do yet" (one PR going green is), the mark
// asks "is anything still in motion" (the other one is). A settled watcher — passing, failing, no checks
// at all, closed, or never polled — is not motion, and falls through to the at-rest ellipsis.
//
// Reading raw `bgShells` here is safe where hasLiveOps could not: this is already gated on the server's
// own `awaitingBackground` verdict, so a stale shell cannot pull a thread into the state — it only picks
// which mark a thread the server already called at-rest-with-work wears.
function restingOnLiveBackgroundWork(t: ThreadView): boolean {
  if (!restingOnBackgroundWork(t)) return false
  if ((t.bgShells ?? []).some((s) => s.state === "running")) return true
  // AN ARMED TIMER IS NOT THE DOT'S BUSINESS ANY MORE (2026-09-07). From 2026-08-24 this counted an armed
  // timer as motion "the same way running CI is" — a wake with a known instant — so a QUEUED rest on a
  // timer wore the shell's blue dot, the mark for "something it launched is still running". Nothing is
  // running behind a timer; the clock is. The maintainer read the dot as a claim of live work
  // (2026-09-07: "an item in the queue that's awaiting a timer should show up with the hourglass icon in
  // the sidebar, not with the flashing blue dot"), so the timer wait is now its own kind — awaitingTimerWatch,
  // resolved ABOVE this predicate in sessionIndicatorKind — and this one is back to what its name says:
  // a shell that is still running, or CI that is. A settled watcher — passing, failing, no checks at all,
  // closed, or never polled — is not motion, and falls through to the at-rest ellipsis.
  return prChecksRunning(t)
}

/** DOES THIS REST SPIN? Only when its worker called it `working` and the server found the work moving —
 *  ThreadView.waitStatus (board.deriveWaitStatus, 2026-10-05). The spinner means that and nothing else:
 *  a QUEUED rest never carries the field, so a queue row never spins, and a `watching` rest is Snoozed
 *  and still. Each at-rest arm that used to spin on its own reading — the shell's dot, the octocat over
 *  running checks — keeps its glyph and asks this whether the frame around it moves (maintainer
 *  2026-10-03: a watcher thread "shouldn't show up as actively running"). */
export function restIsWorking(t: Pick<ThreadView, "waitStatus" | "runtime">): boolean {
  return t.waitStatus === "working" && t.runtime === "turn-idle"
}

/** A PARENT THAT HAS RESTED WHILE ITS SUB-AGENTS ARE STILL OUT — its own turn is over (turn-idle) and a
 *  direct child is running. The thread still resolves to `working` (the child's return re-invokes it, so
 *  the motion is real and the row keeps its place in the Running band), but since 2026-09-20 the mark
 *  inside the spinner is the ELLIPSIS rather than an empty box: the parent itself is at rest, and the
 *  children carry their own spinners on their own indented rows (maintainer 2026-09-19: "the three
 *  ellipses for the top-level parent agent with the spinner, and then the sub-agents can have their own
 *  spinners"). A parent whose OWN turn is running keeps the empty spinner even with children out. */
export function restingOnSubAgents(t: ThreadView): boolean {
  return t.runtime === "turn-idle" && hasLiveSubAgents(t)
}

/** A RUNNING THREAD THAT IS ALSO WAITING ON AN ANSWER — it registered a question (an open
 *  thread_question row, arriving as `questions`) and kept working, as the worker contract tells it to.
 *  sessionIndicatorKind deliberately resolves this to `working`, and the server keeps it out of the queue
 *  until it rests, so before 2026-10-08 the ask was visible only to someone who opened the thread: the
 *  rail drew the plain spinner for the whole stretch the worker spent on work that did not depend on the
 *  answer (reported 2026-10-08: "There were questions I could answer to influence the agent but it
 *  looks like it is still working on other things in the bg"). The `working` arm now draws the "?"
 *  INSIDE the spinner — the motion is real and the band does not change, only the mark inside it says
 *  that an answer would steer the work. Outranks the sub-agent ellipsis: the ask is what the human can act on. */
export function workingWithOpenQuestion(t: ThreadView): boolean {
  return (t.questions?.length ?? 0) > 0 && sessionIndicatorKind(t) === "working"
}

/** AWAITING A PULL REQUEST — the one wait whose subject is not on this machine at all, and since
 *  2026-09-04 a mark of its own wherever it lands.
 *
 *  GitHub's mark used to render in exactly ONE place: the Snoozed band, for a parked row whose fence
 *  happened to name `prs:`. Every other PR wait wore something that said nothing about GitHub — a
 *  watched PR with CI still running drew the shell's blue dot (restingOnLiveBackgroundWork below counts
 *  running checks as motion), and one whose checks had SETTLED fell all the way through to the bare-rest
 *  ellipsis. So the rail drew three different marks for one state, and the only one that named the state
 *  was the one behind a park (maintainer 2026-09-04: "it's kind of weird that this only shows up on a
 *  snoozed card … the GitHub icon should show up anytime that an agent is awaiting a PR").
 *
 *  THE REGISTERED WATCH IS THE PRIMARY SIGNAL, not the fence. `ntwinectl watch-pr` creates the row
 *  the scheduler actually polls, and it is what survives a compaction and a restart; the `prs:` fence
 *  line only ECHOES it (the worker contract: "Register FIRST: this line states the wait, it does not
 *  create one"). Reading the fence alone — which is all the Snoozed arm ever did — therefore misses a
 *  worker that registered a watch and then rested without fencing, which is the shape the contract now
 *  steers workers toward. Both are read here so neither shape loses the mark.
 *
 *  Gated on `turn-idle` so it means AWAITING and nothing else: a thread mid-turn keeps its spinner (a
 *  watch does not stop the work), and an EXITED one stays a stall — its process is gone, Retry is the
 *  next action, and offersRetry reads this same ladder, so taking the stall would silently strip the
 *  recovery verb off the row.
 *
 *  NO SUB-AGENT CARVE-OUT, deliberately, and it took a wrong assertion to see why. `working` is resolved
 *  ABOVE this, so a thread with a live child already spins before it can get here — the ONLY shape that
 *  reaches this line with a child still out is the rested QUEUE HANDOFF (restedQueueHandoff: the server
 *  queued it and its own turn is over), which by long-standing rule reads as rested rather than as
 *  motion. For that row "awaiting a PR" is simply the truer of the two rests, and the children keep
 *  their own spinners on their own indented rows. Excluding them here bought nothing and cost the mark
 *  exactly where it says the most. */
export function awaitingPrWatch(t: ThreadView): boolean {
  if (t.runtime !== "turn-idle") return false
  return waitNamesPr(t)
}

/** Does this thread's wait name a PULL REQUEST at all — the question ALONE, with no opinion about
 *  whether the thread is otherwise free to wear GitHub's mark. Split out because the Snoozed arm asks
 *  exactly this and nothing more: a parked row has already earned its band, and all the rail is
 *  choosing there is hourglass-or-octocat. Keeping one answer is what stops the two surfaces drawing
 *  different marks for one thread — the Snoozed arm read only the fence until 2026-09-04, so a row
 *  parked on a REGISTERED watch it never fenced wore the clock. */
export function waitNamesPr(t: Pick<ThreadView, "watches" | "lastFence">): boolean {
  if ((t.watches ?? []).some((w) => w.kind === "github" && w.state === "armed")) return true
  return t.lastFence?.kind === "awaiting" && t.lastFence.hints.some((h) => (h.kind === "pr" || h.kind === "issue") && h.value.trim() !== "")
}

/** AWAITING A TIMER — parked on the clock, and since 2026-09-07 the hourglass wherever the row lands,
 *  the way the octocat above is GitHub's mark wherever a PR wait lands.
 *
 *  A timer park QUEUED until 2026-09-24 (board.deriveNeedsYou: "a visible handoff, never an auto-park"),
 *  and one that is not honoured — no `for:`, or run out — still does, sitting in the Rested band rather
 *  than in Snoozed. There the row wore the shell's blue dot,
 *  because restingOnLiveBackgroundWork counted an armed timer as motion. The dot is the rail's word for
 *  "a process it launched is still running", and nothing is running behind a timer; the maintainer read
 *  it as exactly that claim (2026-09-07: "an item in the queue that's awaiting a timer should show up
 *  with the hourglass icon in the sidebar, not with the flashing blue dot"). The hourglass is the mark
 *  the rail already uses for "parked on the clock" — the Snoozed band's park, the limit kill's accent
 *  twin — so a queued timer wait joins that family instead of the shell's.
 *
 *  THE REGISTERED ROW IS THE SIGNAL, not the fence. The board synthesizes a `timer` watch row for every
 *  ARMED `thread_timer` (fenceWatchViews), fence or no fence, and only for armed ones — a `timers:` line
 *  naming a fired or cancelled id has no row, and the server treats that fence as a bare rest
 *  (hasParkedTimerWatch). Reading the rows alone therefore never advertises a wake that will not come,
 *  which is the trap the deleted `timer: <instant>` grammar fell into (one was written 5h55m in the past).
 *
 *  Gated on `turn-idle` for the reason awaitingPrWatch is: mid-turn keeps its spinner, and EXITED stays a
 *  stall so the row keeps its Retry (offersRetry reads the resolved kind). Ranked BELOW the PR mark in
 *  sessionIndicatorKind — a thread watching a PR with a timer as its backstop is waiting on GitHub, and
 *  the clock is only how long it will wait — and ABOVE the dot, for the same reason the octocat is: a dev
 *  server the thread also left running is not what it is waiting FOR. */
export function awaitingTimerWatch(t: ThreadView): boolean {
  if (t.runtime !== "turn-idle") return false
  return (t.watches ?? []).some((w) => w.kind === "timer" && w.state === "armed")
}

// One status-priority decision shared by the sidebar renderer and its tests. The order is important:
// an archived row at rest stays archived even if stale attention metadata lingers; a real human ask
// stays a question after the worker exits; live work stays working; and a completed handoff stays a
// check instead of being mislabelled as a crash merely because `needsYou` also puts it in the queue.
export type SessionIndicatorKind = "archived" | "needs-input" | "working" | "background" | "pr" | "timer" | "done" | "stalled" | "limit" | "snoozed" | "rest"

// NO RAIL MARK FOR AN ARMED STOP HOOK, and the reason is worth keeping because one shipped briefly
// (2026-08-02, removed the same day — maintainer: "the whole point of a stop hook is that it means the
// agent never stops, so it should always just be loading").
//
// The rail's marks are mutually exclusive and `working` outranks everything below it, so a mark for
// "this thread has a hook" could only ever render in the gap where the thread is at REST — and a live
// hook has almost no such gap: the thread works, stops, and is bumped again within a tick. What it DID
// render on was the one at-rest state that lasts, the thread whose agent answered AWAITING — where the
// mark said "ntwine will act on this" about a loop that had just closed itself. It was invisible when
// true and wrong when visible.
//
// The prompt box's RecurringPromptControl carries the state instead, where it is legible and editable.

export function sessionIndicatorKind(t: ThreadView): SessionIndicatorKind {
  // DONE IS THE HUMAN'S TO UNDO, and nothing a worker does afterwards un-archives the thread. But a live
  // session never sits under Done (upstream, hit 3× before 2026-07-10): while its turn drains or a sub-agent
  // it dispatched is still out, `sectionOf` lifts the row into Running and it wears the spinner (shared
  // doneButRunning), then settles back into Done, with its check, the moment it comes to rest. The mark
  // says what the process is doing; the row's Done dim and uncheck box say what the human decided.
  if (t.state === "archived") return doneButRunning(t) ? "working" : "archived"
  const activelyRunning = isActivelyRunning(t)

  // A PARK THE OPERATOR SET OUTRANKS EVERY ASK MARK BELOW IT — the order the SERVER already derives the
  // queue in (deriveNeedsYou checks futureSnooze before pendingAsk, pendingQuestion and the registered
  // rows), and the order isSnoozed itself states in prose: "a user-owned snooze deliberately wins over a
  // concrete ask, permission prompt, or crash". Only the MARK disagreed, and the disagreement was
  // visible: a snoozed thread carrying an unanswered ```question sat in the dimmed Snoozed band wearing
  // the [?] of a queue member while the server had dequeued it, so NOTHING anywhere drew the question the
  // mark advertised (maintainer 2026-08-31: "marked as a question status, but there is no question
  // rendering"). Measured on this machine that day: 3 of the 37 threads the rail marked [?] had no card
  // on any surface, on three different projects, and all three were user-snoozed with a pending ask.
  // Gated on isSnoozed so its carve-outs still hold — a running turn and a live sub-agent keep their
  // spinner, because motion is a fact about the process that a park does not change — and on
  // futureSnoozedUntil so ONLY the operator's own wall-clock park takes this branch: a declared wait or
  // an event-snooze leaves the thread QUEUED server-side, where the ask is reachable and the [?] is true.
  if (futureSnoozedUntil(t) !== undefined && isSnoozed(t)) return "snoozed"
  // SNOOZED UNTIL ALL SUB-AGENTS RETURN is the other park that must outrank the spinner below: its row
  // has live children by definition, so `working` would claim it on every rest, in the Snoozed band the
  // human just put it in. The server only sets the flag while nothing queues the thread, so no ask mark
  // below can be true of it; mid-turn it is dropped, and the row spins in Active like any snoozed one.
  if (t.subAgentsSnoozed === true && isSnoozed(t)) return "snoozed"

  const explicitlyNeedsInput = Boolean(
    t.actionableInteraction ||
      t.pendingAsk ||
      t.pendingQuestion ||
      t.runtime === "perm-prompt" ||
      t.humanBlocked ||
      t.status === "needs-human",
  )
  if (explicitlyNeedsInput) return "needs-input"
  // "Working" is motion the thread genuinely has: its own turn in flight (running/spawning), or a live
  // SUB-AGENT whose return will re-invoke it, while the parent is NOT yet a handoff. A rested, queued
  // thread falls through to the at-rest ellipsis below no matter how many sub-agents it still has out —
  // see restedQueueHandoff. A shell-only rest is carved out because it is never motion at all; the dot
  // below is its mark, and without this clause an event-snoozed one would still spin.
  if (activelyRunning && !restedQueueHandoff(t) && !restingOnBackgroundWork(t)) return "working"
  // A REGISTERED question (an open thread_question row, arriving as `questions`) is as concrete an ask
  // as any of the explicit flags above, but it deliberately sits BELOW the working branch: a worker
  // that registers a question keeps working, and the ask must not stop its spinner (the same reason
  // board.ts keeps these rows out of degradeIfAwaitingAnswer). Once the thread is at rest the server
  // queues it (deriveNeedsYou's openQuestions) and the card renders the ask — so the rail must say "?"
  // rather than the bare-rest ellipsis it wore before this branch existed (maintainer 2026-08-31: a
  // queue card showing a question beside a row marked […]). Above "snoozed" and "stalled" on purpose:
  // an ask outranks a park, and a real human ask stays a question after the worker exits.
  if ((t.questions?.length ?? 0) > 0) return "needs-input"

  if (isSnoozed(t)) return "snoozed"
  // KILLED BY A USAGE LIMIT. Its own attention mark — the yellow hourglass — because it is BOTH things
  // at once: dead like a stall (hence yellow, and the same one-click Retry), and a wait on provider
  // capacity rather than a crash (hence the hourglass, not the [!]). It wore the muted Snoozed
  // hourglass until 2026-08-31 (maintainer: killed threads "showed up and fucking snoozed … they're
  // not showing up as yellow in the sidebar"). Below isSnoozed so the operator's own wall-clock snooze
  // still parks the row; above the done fence and the background dot, both of which would be a STALE
  // story from before the kill (the fault postdates any fence, and nothing of the thread's is coming
  // back until the window resets). PRESENCE, not `autoResume`: a pause ntwine will not resume by itself
  // (an unknown phrasing, an aged-out fault) is still a limit kill, and the tip says which story holds.
  if (t.limitPause && t.foreign !== true) return "limit"
  if (t.lastFence?.kind === "done" && atRest(t)) return "done"
  // AWAITING A PR — GitHub's own mark, in whichever band the row sits (awaitingPrWatch). ABOVE the
  // background dot because a watched PR is not this machine's work: a dev server the thread also left
  // running is not what it is waiting FOR, and the dot said "something here is alive" about a wait whose
  // subject is a review queue somewhere else. BELOW the done fence and the limit kill, which are both
  // later facts than the park — a killed or dismissed thread is not awaiting anything.
  if (awaitingPrWatch(t)) return "pr"
  // AWAITING A TIMER — the hourglass, in whichever band the row sits (awaitingTimerWatch). Below the
  // PR mark: a timer beside a PR watch is the watch's backstop, not the subject. Above the dot: a timer
  // park in the QUEUE wore the shell's blue dot until 2026-09-07, which claimed live work behind a
  // thread whose only pending event is a wake ntwine will deliver. NOT FOR A `working` REST: the timer
  // there is the backstop of a shell the worker named, and that shell is the motion the row spins for.
  if (awaitingTimerWatch(t) && !restIsWorking(t)) return "timer"
  // Below the two DECLARED states on purpose. A worker that fenced ```done while a server it never
  // killed keeps running is a one-click dismissal, not live work (NTWINE.md: "name it in the body and
  // fence anyway"), and a parked ```awaiting is the human's gate — either story outranks "something it
  // launched is still going". The ordering is LOAD-BEARING now rather than merely declarative: it used
  // to be unreachable because deriveAwaitingBackground dropped any fenced thread, and since a timer park
  // sets the flag ON its ```awaiting fence (f50f9e60), a real production row reaches both — the fenced
  // timer park, which takes "snoozed" here and the dimmed band in sectionOf.
  if (restingOnLiveBackgroundWork(t)) return "background"
  // STALLED = this thread's PROCESS IS GONE with the work unfinished. That is exactly `canRetry`: an
  // OWNED (non-foreign) session row whose runtime is `exited`. It deliberately does NOT consult the
  // server's `crashed` bit (= exited AND turn-in-flight/live-background-work). `crashed` says only HOW
  // it stopped; a worker that exited at BARE REST — no done fence, turn not in flight — is just as
  // dead and just as unable to move without a nudge, so it earns the same [!] mark. Gating the mark on
  // `crashed` while the Retry verb gated on the process being gone is precisely what let the queue
  // card and the rail row disagree about ONE thread (maintainer 2026-07-23: "the card in the queue has
  // a retry button, but it's not marked as stalled in the sidebar with the yellow and the exclamation
  // point"). The tooltip still names the distinction; the glyph and the verb no longer care about it.
  // Every branch ABOVE wins first, so an archived / needs-input / working / held / done-fenced row
  // keeps its own better-suited mark and affordance even when its process happens to be gone.
  if (canRetry(t)) return "stalled"
  // Bare rest with a LIVE process (turn-idle, nothing pending, NOTHING it launched still running): it
  // can simply be typed at, so it stays the quiet […] and never advertises a recovery verb.
  return "rest"
}

// Whether a thread offers the Retry verb — on EVERY surface: the sidebar rail row, the queue card,
// AND the full thread drawer's header. The load-bearing invariant is that all three surfaces read
// THIS ONE predicate, so no two of them can ever drift apart about a single thread (each time a
// surface kept its own gate, one ended up showing Retry while reading as calm at-rest elsewhere —
// maintainer 2026-07-23, twice).
//
// Two states earn Retry, and they wear DIFFERENT sidebar marks — the verb is shared, the glyph is not:
//   • STALLED — the process is gone with the work unfinished (yellow [!]). The classic case.
//   • KILLED BY A USAGE LIMIT ntwine will auto-resume (the yellow hourglass — the "limit" kind). It
//     queues as a failed thread (deriveNeedsYou, 2026-08-31) and ntwine continues it itself once the
//     window resets, but the operator with capacity elsewhere shouldn't have to wait, so it gets the
//     same one-click Retry: the same verb, message and RPC as a stall (retrySession sends the very
//     "Continue exactly where you left off." the in-drawer LimitPauseCard already offers) — a faster
//     door from the rail (maintainer 2026-07-23: limit-killed rows want the same one-click retry as
//     stalled rows). This is why offersRetry is NOT simply `kind === "stalled"`. The invariant the
//     maintainer reads the rail by (2026-08-31): EVERY YELLOW ROW carries the hover Retry.
// The "limit" kind keys on the fault's PRESENCE, so a pause ntwine will not resume by itself (an
// unknown phrasing, an aged-out fault) still wears the yellow hourglass and this same Retry — for
// that row the Retry is not a shortcut but the only way back.
//
// The drawer used to be deliberately broader — raw `canRetry` (ANY exited owned session) — on the
// theory that the full view should show every recovery option. That was wrong twice over, and it is
// the bug the maintainer hit (2026-07-23, second report): `canRetry` does not consult `state`, so all
// 158 ARCHIVED-and-exited threads on the real board opened with a Retry pill while their rail row
// showed the muted [✓] — "a thread that appears to have just come to rest, with a retry button, not
// yellow, no exclamation point". Nothing is lost by narrowing: the drawer has a composer, and sending
// an archived or done thread a message is already how you reopen it (see StateButton).
export function offersRetry(t: ThreadView): boolean {
  const kind = sessionIndicatorKind(t)
  // Gated on the RESOLVED kinds (never raw limitPause/canRetry) so a higher-priority state that stole
  // the row — a fresh ask, live work, the operator's own snooze — never sprouts a Retry. Both kinds
  // are non-foreign by construction, so each stays a session ntwine can actually restart.
  return kind === "stalled" || kind === "limit"
}

// This section is TWO rule-separated bands (the project board's Sidebar drew the rule, until that board
// went on 2026-09-28; ProjectList.tsx now draws Ready and Working from the server's queued and running
// lists): the RESTED band (a.k.a. the
// queue, a.k.a. the cue) on TOP, directly beneath the prompt box, then the ACTIVE band — everything the
// human has nothing to answer, spinning or merely in flight — BELOW it. Rested is ordered by the EXACT
// queue comparator (orderQueue), so the rested rows and the queue cards share ONE order. That shared
// order is what makes the scroll-position marker monotonic: scrolling the queue down walks the marker
// straight down the rail instead of hopping around (maintainer 2026-07-15: the queue/sidebar mismatch
// "totally defeats the purpose of the scroll position indicator"; running agents "should not render in
// the queue at all"). Putting the cue first (maintainer 2026-08-08) aligns the rail's top with the
// workpane's top: the first card in the queue is now opposite the first row in the rail. Active rows have
// no queue card, so their interaction-recency order never affects the marker — grouping them below just
// keeps everything that isn't waiting on the human out of the rested run.
//
// This ORDER WAS THE RENDER ORDER: the project board's Sidebar split the result with partitionActive and
// drew the two bands in the order they came out of here, so the array and the rail could never disagree
// about which band was on top. No surface renders straight from it now; sectionThreads still orders its
// `active` bucket with it.
export function orderActive(threads: readonly ThreadView[], direction: QueueDirection = "fifo"): ThreadView[] {
  const running = threads.filter(inActiveBand)
  const rested = threads.filter((t) => !inActiveBand(t))
  return [...orderQueue(rested, direction), ...orderByInteraction(running)]
}

// Split an ALREADY-ordered list (see orderActive) into its Active/Rested bands WITHOUT re-sorting —
// filter() preserves orderActive's order — where the project board's Sidebar drew its separating rule,
// and the band oracle the groups tests still check a row against. `.running` is
// the ACTIVE band (spinning, plus the handful of rows that are in flight without a card of their own);
// `.rested` is the queue's rows, exactly one per card. The key is named for the spinner that dominates
// it, the band is named for the maintainer's word — see the vocabulary at the top of this section.
export function partitionActive(active: readonly ThreadView[]): { running: ThreadView[]; rested: ThreadView[] } {
  return {
    running: active.filter(inActiveBand),
    rested: active.filter((t) => !inActiveBand(t)),
  }
}

// THE BAND A THREAD'S STATE PUTS IT IN, by the names the rail's headers print rather than the section
// keys above: READY is the cue (it has a queue card), WORKING the band below the rule, then SNOOZED,
// DONE, and EXTERNAL for a terminal session Ntwine does not own. The same derivation the rail's bands
// run, so a surface that names the band — the drawer header's stamp — can never disagree with the band
// the row actually sits in.
//
// It IGNORES THE PIN on purpose. A pin moves the row, never the state (see isPinned): a pinned thread
// that is spinning is still Working, and the stamp says what the thread is doing, not where the human
// shelved it. Legacy `.ntwine` rows have no band (null), as they have no row.
export type Band = "ready" | "working" | "snoozed" | "done" | "external"
export function bandOf(t: ThreadView): Band | null {
  if (t.kind === "session" && t.foreign === true) return "external"
  const section = sectionOf(t)
  if (section === "inactive") return "done"
  if (section === "snoozed") return "snoozed"
  if (section === "active") return inActiveBand(t) ? "working" : "ready"
  return null
}

// Partition threads into the thread-derived sidebar sections. `active` is the Active+Rested section and
// is banded by orderActive (spinning rows first, then the queue's own order); Snoozed and Done are plain
// interaction recency.
// `pinned` rides beside the three SectionKey buckets rather than inside them (see isPinned): a pinned
// row must be claimable by NO band, and keeping it out of the Record is what makes that true by
// construction instead of by every band remembering to exclude it.
export type SectionedThreads = Record<SectionKey, ThreadView[]> & { pinned: ThreadView[] }
export function sectionThreads(threads: readonly ThreadView[], direction: QueueDirection = "fifo"): SectionedThreads {
  const out: SectionedThreads = { pinned: [], active: [], snoozed: [], inactive: [] }
  for (const t of threads) {
    if (t.kind === "session" && t.foreign === true) continue // foreign sessions never row (nor strip — dropped)
    if (isPinned(t)) {
      out.pinned.push(t)
      continue
    }
    const k = sectionOf(t)
    if (k) out[k].push(t)
  }
  // Pin order, oldest pin first: the band is a shelf the human arranged, so nothing about the threads'
  // own activity may reorder it. Slug tiebreak keeps two same-instant pins stable across renders.
  out.pinned.sort((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? "") || a.id.localeCompare(b.id))
  out.active = orderActive(out.active, direction)
  out.snoozed = orderByInteraction(out.snoozed)
  out.inactive = orderByInteraction(out.inactive)
  return out
}
