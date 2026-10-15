import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AgentRow, AwaitingBackgroundCard, AwaitingWaitTable, awaitingBackgroundLabel, awaitingBackgroundSubject, restingOnSteps, showsRestingCard, stoppableShellIds } from "./AwaitingBackgroundCard.tsx"
import { CHILD_STALE_SHELL_TITLE } from "../lib/childOps.ts"
import type { ThreadView } from "@ntwine/shared"

// One card, three surfaces, and since 2026-08-15 one TABLE: every kind of live work the thread declared
// gets a row, grouped by kind, with a light-gray status right-justified and a chevron
// (maintainer: "Definitely group them by kind. They should all consistently use the chevron […] and right
// justify the status label").
//
// What these pin is what can silently go wrong: a row claiming work that is not live, a kind losing its
// row entirely (which is how a declared shell watch went unrendered for a day), and the snooze leaking
// onto a surface that must not offer it.

const agent = (state: "running" | "stale") => ({ id: "toolu_a", label: "Audit the parser", subagentType: "ntwine:opus-high", startedAt: "2026-07-28T09:00:00.000Z", state })
// A live sub-agent OF a sub-agent (depth 2 = a grandchild, 3 = a great-grandchild).
const nested = (depth: number) => ({ id: `toolu_d${depth}`, label: "Trace the cache key", startedAt: "2026-07-28T09:00:00.000Z", state: "running" as const, depth })
const shell = (state: "running") => ({ id: "toolu_s", taskId: "bzvtnt3ig", label: "vite dev", startedAt: "2026-07-28T09:00:00.000Z", state })
// An OWNED SESSION thread AT REST ON ITS OWN PARK, because those are the two things the card decides
// its Snooze off: `threadLifecycleAvailability` (2026-08-31 — a bare `{id, subAgents, bgShells}` is not
// a thread anyone can act on) and `showsRestingCard` (2026-09-04 — the card now draws at every runtime,
// through ChatView's fence block, and offers the park only where there is a rest to park). A fixture
// omitting either would silently pin the card's no-verb branch while claiming to test the ordinary one.
const thread = (subAgents: unknown[], bgShells: unknown[]) =>
  ({ id: "demo-thread", sessionId: "sess-demo", kind: "session", awaitingBackground: true, runtime: "turn-idle", subAgents, bgShells } as unknown as Parameters<typeof AwaitingBackgroundCard>[0]["thread"])

// A DECLARED shell wait — what a worker's `watch: <handle>` fence hint becomes server-side.
const shellWatch = (target: string) => ({ id: `shell:demo:${target}`, kind: "shell" as const, target, state: "armed" as const, createdAt: "2026-07-28T09:00:00.000Z" })
const watcher = () => ({ id: "github:t:acme/app#1", kind: "github" as const, target: "acme/app#1", state: "armed" as const, createdAt: "2026-07-28T09:00:00.000Z" })
// An ARMED TIMER — what a `thread_timer` registration becomes server-side (board.fenceWatchViews). The
// fire instant is built off the real clock because the row renders a live countdown against Date.now.
const timerWatch = (inMinutes = 34, prompt = "Re-check: tip quiet, install green") => ({
  id: "timer:demo:tmr_a1",
  kind: "timer" as const,
  target: "tmr_a1",
  state: "armed" as const,
  createdAt: "2026-07-28T09:00:00.000Z",
  timer: { fireAt: new Date(Date.now() + inMinutes * 60_000).toISOString(), prompt },
})

// In a QueryClient: a sub-agent rest with no fence offers Keep working (lib/keepWorking.ts), whose send
// reads the page's client.
const render = (t: Parameters<typeof AwaitingBackgroundCard>[0]["thread"]) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AwaitingBackgroundCard, { thread: t })))
const text = (t: Parameters<typeof AwaitingBackgroundCard>[0]["thread"]) =>
  render(t).replace(/<[^>]+>/g, "").replace(/&#x27;|&rsquo;/g, "’")

test("awaitingBackgroundSubject names exactly the work that is RUNNING", () => {
  assert.equal(awaitingBackgroundSubject(thread([agent("running")], [])), "1 sub-agent")
  assert.equal(awaitingBackgroundSubject(thread([agent("running"), agent("running")], [])), "2 sub-agents")
  // A shell-only thread must never claim a sub-agent: a launched dev server is not a child whose
  // result you await. The noun is the rows' own ("agent terminals", as the ops strip names them), matching the title.
  assert.equal(awaitingBackgroundSubject(thread([], [shell("running")])), "1 agent terminal")
  assert.equal(awaitingBackgroundSubject(thread([], [shell("running"), shell("running")])), "2 agent terminals")
  // BOTH kinds live — the case that used to drop the shells behind the agent count entirely.
  assert.equal(awaitingBackgroundSubject(thread([agent("running")], [shell("running")])), "1 sub-agent and 1 agent terminal")
  // A STALE sub-agent is not live work: it must not be counted, and with a live shell beside it the
  // sentence falls back to the shell alone rather than claiming a sub-agent that stopped reporting.
  assert.equal(awaitingBackgroundSubject(thread([agent("stale")], [shell("running")])), "1 agent terminal")
  // A DESCENDANT — a sub-agent's own sub-agent — rides `subAgents` so the rows can nest, but the
  // sentence says "it dispatched", and this thread's worker dispatched no such thing.
  assert.equal(awaitingBackgroundSubject(thread([agent("running"), nested(2), nested(3)], [])), "1 sub-agent")
})

// NO SNOOZE ON THE RESTING CARD (2026-10-14). It carried "until new activity" from 2026-08-31, and that
// park hid threads that were still working; Snoozed is a time the human picks from the header now.
test("the resting card states the wait and offers no snooze", () => {
  const bare = render(thread([agent("running")], []))
  assert.doesNotMatch(bare, /Snooze/)
  // Its one verb is Keep working: a rest with no fence while a sub-agent runs (KeepWorking.test.ts).
  assert.match(bare, /data-card-actions="true"[^>]*><button[^>]*data-keep-working[^>]*>Continue<\/button><\/div>/)
  assert.match(bare, /Awaiting/)
  assert.match(bare, /data-wait-kind="agent"/)
})

// THE TITLE NAMES THE SHAPE, and there are two of them (maintainer 2026-08-04: 'the card that says
// "awaiting background work" should be renamed to "background shells running"'). The rename is scoped to
// the rest it describes: a shell-only rest is the one that queues, and it is not awaiting anything.
test("the card's title names the shape: shells running vs awaiting a dispatched result", () => {
  const shellsOnly = text(thread([], [shell("running"), shell("running")]))
  assert.match(shellsOnly, /Agent terminals running/)
  assert.doesNotMatch(shellsOnly, /Awaiting/)

  const withChild = text(thread([agent("running")], [shell("running")]))
  assert.match(withChild, /Awaiting/)
  assert.doesNotMatch(withChild, /Agent terminals running/)
})

// …AND THE WORKER MAY OVERRIDE BOTH (maintainer 2026-08-26: "let's let the agent specify its own title
// for these awaiting cards"). "Awaiting" is true of every park on the board and specific to none, and the
// worker is the only party that knows what THIS wait is. Capped at parse time, so the card renders the
// hint verbatim and cannot draw a heading longer than the grammar allows.
const titled = (value: string) => ({ kind: "awaiting" as const, body: "", hints: [{ kind: "title" as const, value }] })

test("a title: in the fence replaces the derived heading, on either shape", () => {
  const declared = { ...thread([agent("running")], []), lastFence: titled("Three-platform CI run") } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.match(text(declared), /Three-platform CI run/)
  assert.doesNotMatch(text(declared), /Awaiting/)
  // The shell-only shape has a kind-naming heading of its own, and a declared title beats that too.
  const shells = { ...thread([], [shell("running")]), lastFence: titled("Nightly bench, arm 3 of 3") } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.match(text(shells), /Nightly bench, arm 3 of 3/)
  assert.doesNotMatch(text(shells), /Agent terminals running/)
})

test("an empty or absent title falls back to the derived heading", () => {
  const blank = { ...thread([agent("running")], []), lastFence: titled("   ") } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.match(text(blank), /Awaiting/)
  // A DONE fence's hints are never a heading — only a standing awaiting park may name this card.
  const done = { ...thread([agent("running")], []), lastFence: { kind: "done" as const, body: "", hints: [{ kind: "title" as const, value: "Landed" }] } } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.match(text(done), /Awaiting/)
  assert.doesNotMatch(text(done), /Landed/)
})

// ---- ONE CARD, EVERY RUNTIME (2026-09-04) --------------------------------------------------------
// The awaiting FENCE used to draw a second card of its own in ChatView whenever the thread was not at
// rest on it — its own heading rule, its own glyph, its own prose fallback, its own PR chips — so
// steering a worker re-shaped the card under the human ("I'll steer an agent with a new message, and
// it'll re-render the awaiting card in a totally different fucking way"). That card is gone; FenceCard
// renders THIS one, handing in the fence it parsed. What these pin is the two things that made that
// possible, because both are reachable only from that caller.

test("the fence is a PARAMETER, so one card states a fence the board no longer holds", () => {
  // The bumped thread exactly: the timers survive in their own registry, `lastFence` does not — the
  // tailer clears it on the user record that bumps the thread — and the shell is only nameable because
  // the fence's own hints came in with it.
  const bumped = { ...thread([], [shell("running")]), watches: [timerWatch()] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  const hints = [{ kind: "title" as const, value: "0.6.0 release hold" }, { kind: "shell" as const, value: "bzvtnt3ig" }]
  // The BODY stays empty in every case here, for the reason the unified-card block below states: prose
  // goes through the markdown sanitizer, which needs a real DOM this runner does not have. The heading,
  // the rows and the placeholder are all DOM-free, and they are what these pin.
  const html = renderToStaticMarkup(createElement(AwaitingBackgroundCard, { thread: bumped, fence: { body: "", hints } }))
  assert.match(html.replace(/<[^>]+>/g, ""), /0\.6\.0 release hold/, "the worker's own heading, off the fence handed in")
  assert.match(html, /data-wait-row="bzvtnt3ig" data-wait-kind="shell"/, "…and its shell rows off the same hints")
  assert.match(html, /data-wait-kind="timer"/, "the registry rows are still the thread's")
  // The thread's OWN fence never wins over one handed in: at a bump they disagree, and the caller is
  // the one holding the fence the card is about.
  const stale = { ...bumped, lastFence: { kind: "awaiting", body: "", hints: [{ kind: "title", value: "Something else" }] } } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  const overridden = renderToStaticMarkup(createElement(AwaitingBackgroundCard, { thread: stale, fence: { body: "", hints } })).replace(/<[^>]+>/g, "")
  assert.match(overridden, /0\.6\.0 release hold/)
  assert.doesNotMatch(overridden, /Something else/)
})

// A SUB-AGENT'S OWN TRANSCRIPT has no owning thread — no board row, so no rows and no verb — and a fence
// still has to card there. It is also the ONE place the card can have neither prose nor rows, which is
// what the placeholder sentence is for: a bare heading says less than a sentence does.
test("a card with no thread is still the card: its heading, no rows, no verb", () => {
  const bare = renderToStaticMarkup(createElement(AwaitingBackgroundCard, { fence: { body: "", hints: [{ kind: "title", value: "Three-platform CI run" }] } }))
  assert.match(bare.replace(/<[^>]+>/g, ""), /Three-platform CI run/)
  assert.match(bare, /data-awaiting-background/)
  assert.doesNotMatch(bare, /data-wait-kind/, "no thread, no live work, no rows")
  assert.doesNotMatch(bare, /Snooze/, "…and nothing to park")
  // Neither shape may card as blank.
  const empty = renderToStaticMarkup(createElement(AwaitingBackgroundCard, { fence: { body: "", hints: [] } })).replace(/<[^>]+>/g, "")
  assert.match(empty, /Awaiting/)
  assert.match(empty, /Waiting for an external update\./)
  // …but a card with ROWS says nothing of the kind — the rows are what it has to say.
  const rowed = render({ ...thread([agent("running")], []) } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"])
  assert.doesNotMatch(rowed, /Waiting for an external update/)
})

// ---- ONE ROW PER THING, GROUPED BY KIND ----------------------------------------------------------
test("every kind the thread declared gets a row, under its own heading", () => {
  const t = {
    ...thread([agent("running")], [shell("running")]),
    watches: [shellWatch("bzvtnt3ig"), watcher(), timerWatch()],
  } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  const html = render(t)
  assert.match(html, /data-wait-kind="agent"/)
  assert.match(html, /data-wait-kind="shell"/)
  assert.match(html, /data-wait-kind="github"/)
  assert.match(html, /data-wait-kind="timer"/)
  const body = text(t)
  for (const head of ["Sub-agents", "Agent terminals", "Pull requests", "Timers"]) assert.match(body, new RegExp(head))
  // MOST-ALIVE FIRST, the order the ops strip already settled: a sub-agent and a shell are running right
  // now, a watched PR is waiting on somebody else, and a timer is waiting on nothing but the clock.
  assert.ok(body.indexOf("Sub-agents") < body.indexOf("Agent terminals"))
  assert.ok(body.indexOf("Agent terminals") < body.indexOf("Pull requests"))
  assert.ok(body.indexOf("Pull requests") < body.indexOf("Timers"))
})

// THE FOURTH KIND (maintainer 2026-08-24: this card "enumerates all of the pull requests and the
// background shells … I don't understand why timer isn't represented in the same way"). The row's NAME
// is the timer's own prompt — the id names nothing to a human — and its status counts down to the fire
// instant. Non-interactive by the settled id-less policy: nothing to open, so no chevron and no control.
test("an armed timer gets a row: named by its prompt, counting down, non-interactive", () => {
  const t = { ...thread([], []), watches: [timerWatch()] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  const body = text(t)
  assert.match(body, /Timers/)
  assert.match(body, /Re-check: tip quiet, install green/)
  assert.match(render(t), /data-wait-status[^>]*>in 3[34]m</, "the Timers heading carries the verb")
  const rows = renderToStaticMarkup(createElement(AwaitingWaitTable, { thread: t, divider: false }))
  assert.doesNotMatch(rows, /lucide-chevron-right/, "nothing to open, so no chevron")
  assert.doesNotMatch(rows, /<a |<button/, "no dead link and no disabled control either")
  // A DUE-BUT-UNDELIVERED timer (the scheduler's tick runs seconds behind the instant) says so in the
  // present progressive rather than counting to zero or negative.
  assert.match(text({ ...thread([], []), watches: [timerWatch(-1)] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]), /firing…/)
})

// The kind-naming title is for background shells and NOTHING else: with a timer beside them the card
// holds a Timers group too, and "Background shells running" would name only half the wait.
test("a timer beside running shells takes the generic title", () => {
  const t = { ...thread([], [shell("running")]), watches: [shellWatch("bzvtnt3ig"), timerWatch()] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.match(text(t), /Awaiting/)
  assert.doesNotMatch(text(t), /Agent terminals running/)
})

test("a heading never appears over an empty group", () => {
  const agentsOnly = text(thread([agent("running")], []))
  assert.match(agentsOnly, /Sub-agents/)
  assert.doesNotMatch(agentsOnly, /Agent terminals/)
  assert.doesNotMatch(agentsOnly, /Pull requests/)
})

// A SHELL REACHES THIS CARD ONLY WHEN THE WORKER DECLARED IT — the same rule the server applies to decide
// the card exists at all (board.hasDeclaredWait: "a dev server, a log tail and a test run are the same
// row here, and only the worker knows which of them it is actually resting behind"). This is the bug the
// table fixed: the fence parsed, the server built the `kind: "shell"` row, and the card dropped it.
test("a declared shell gets a row; an undeclared one running beside it does not", () => {
  const declared = {
    ...thread([], [shell("running"), { id: "toolu_x", taskId: "b7k2m1xq0", label: "some other server", startedAt: "2026-07-28T09:00:00.000Z", state: "running" }]),
    watches: [shellWatch("bzvtnt3ig")],
  } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  const body = text(declared)
  assert.match(body, /vite dev/, "the declared shell is named by its label, resolved off its taskId")
  assert.doesNotMatch(body, /some other server/, "an undeclared shell says nothing")

  // NO DECLARATION AT ALL ⇒ no shell rows, whatever is running. (The card still TITLES itself
  // "Background shells running" for that shape — the assertion has to be on the row, not the word.)
  assert.doesNotMatch(render(thread([], [shell("running")])), /data-wait-kind="shell"/)
})

test("a shell watch resolves its label off ANY of the three legal handles", () => {
  for (const target of ["toolu_s", "bzvtnt3ig", "vite dev"]) {
    const t = { ...thread([], [shell("running")]), watches: [shellWatch(target)] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
    assert.match(text(t), /vite dev/, `${target} should resolve to the shell`)
  }
  // An UNRESOLVABLE target still renders, naming itself — never a vanished wait.
  const orphan = { ...thread([], []), watches: [shellWatch("bzz-nothing")] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.match(text(orphan), /bzz-nothing/)
})

// A declared watch outlives the shell it names: the OS confirms the process gone (tailer `shellIsGone`),
// no completion ever arrives, and this row is the reason the thread is back in the queue. It read
// "running · …" in the shell blue until 2026-10-05; since 2026-10-08 its status is the elapsed time
// alone, and the grey mark and the tooltip say it is gone.
test("a declared shell whose process is gone reads stale, never running", () => {
  const dead = { ...thread([], [{ ...shell("running"), state: "stale" }]), watches: [shellWatch("bzvtnt3ig")] } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  const html = render(dead)
  const row = html.slice(html.indexOf('data-wait-kind="shell"'))
  assert.doesNotMatch(row, /data-wait-status[^>]*>[^<]*stale/, "the mark and tooltip carry it, not the status")
  assert.doesNotMatch(row, /running/)
  assert.doesNotMatch(row, /text-shell/, "a dead process does not wear the live shell blue")
  assert.ok(row.includes(CHILD_STALE_SHELL_TITLE), "the tooltip says the process exited")
})

test("sub-agent rows are DIRECT and RUNNING only", () => {
  const t = thread([agent("running"), agent("stale"), nested(2)], [])
  const html = render(t)
  assert.equal(html.match(/data-wait-kind="agent"/g)?.length, 1)
  assert.doesNotMatch(text(t), /traceTheCacheKey|Trace the cache key/, "a grandchild was dispatched by the child, not by this thread")
})

// ---- WHAT THE ROW SAYS ---------------------------------------------------------------------------
test("a row with nothing to open is non-interactive — no chevron, never a disabled control", () => {
  const openable = render({ ...thread([agent("running")], []) } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"])
  assert.match(openable, /lucide-chevron-right/)
  // No id ⇒ nothing to drill into. ChildOpRow's settled policy, applied here.
  const idless = thread([{ label: "Audit the parser", startedAt: "2026-07-28T09:00:00.000Z", state: "running" }], [])
  const idlessRows = renderToStaticMarkup(createElement(AwaitingWaitTable, { thread: idless, divider: false }))
  assert.doesNotMatch(idlessRows, /lucide-chevron-right/)
  assert.doesNotMatch(idlessRows, /disabled/)
  assert.match(text(idless), /audit-the-parser/, "…and the row is still there, named by its handle")
})

// The profile is the TOOLTIP's, not the status's (maintainer 2026-10-08): the status keeps the one
// reading that changes, and the title keeps its width.
test("the sub-agent row keeps its profile in the tooltip, without the dispatch namespace", () => {
  const now = Date.parse("2026-07-28T09:30:00.000Z")
  const row = renderToStaticMarkup(createElement(AgentRow, { agent: agent("running"), slug: "demo-thread", now }))
  assert.match(row, /title="Open this sub-agent \(opus-high\) — working for 30m"/)
  assert.doesNotMatch(row, /ntwine:opus-high/)
  assert.match(row, /data-wait-status[^>]*>30m</)
})

// THE SENTENCE IS THE FALLBACK NOW, not the content. Every kind has a row, so counting the same things in
// prose above them is one fact written twice — the restatement that made this card busy (2026-08-14).
test("the prose sentence yields to the rows entirely", () => {
  const withRows = text(thread([agent("running")], []))
  assert.doesNotMatch(withRows, /awaiting the results from/)
  assert.doesNotMatch(withRows, /still running\./)
  // …and survives for the one reachable gap: a declared wait whose rows all failed to resolve.
  const noRows = text(thread([agent("stale")], [shell("running")]))
  assert.match(noRows, /1 agent terminal is still running/)
})

// ---- THE UNIFIED CARD (2026-08-24) ---------------------------------------------------------------
// Maintainer: "the card consist of the rendered message at the top of the card, followed by a
// horizontal divider, followed by all of the awaited items. Then we could put the snooze button in a
// footer." The fence's body used to render as a SEPARATE message above this card; now the card opens
// on it, and FenceCard renders nothing when the card shows.
//
// THE PROSE STRATUM ITSELF IS NOT PINNED HERE: rendering it calls the markdown pipeline, whose
// sanitizer needs a real DOM (lib/markdown.ts), and this file runs under node --test. What CAN be
// pinned DOM-free is everything around it — the divider's coupling to the prose, the machinery
// filter, the done-fence guard, the footer band — and the rendered prose is verified in the browser
// against a real parked worker (scripts/seed-timer-park.mjs).
test("no prose, no divider — and non-prose fences contribute nothing", () => {
  // Rows alone (a bare sub-agent rest has no fence): no seam over nothing.
  const bare = render({ ...thread([agent("running")], []) } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"])
  assert.doesNotMatch(bare, /-mx-4 mt-3 border-t border-border/)
  // A fence whose body is only unparsed machinery lines renders no prose and no divider either —
  // raw fence syntax must never reach the reader (awaitingProseBlock strips it to null).
  const machinery = {
    ...thread([], []),
    watches: [timerWatch()],
    lastFence: { kind: "awaiting", body: "watch: bzvtnt3ig", hints: [] },
  } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.doesNotMatch(render(machinery), /bzvtnt3ig/)
  assert.doesNotMatch(render(machinery), /-mx-4 mt-3 border-t border-border/)
  // A done fence is not a wait — its body must not open this card.
  const done = {
    ...thread([agent("running")], []),
    lastFence: { kind: "done", body: "All landed.", hints: [] },
  } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.doesNotMatch(text(done), /All landed/)
})

// THE TABLE AS A PIECE (2026-08-28). The awaiting FENCE card draws it whenever the thread is NOT at rest
// on its fence — mid-turn on a follow-up, or woken by the shell it named — where it used to print the
// fence's machinery as one muted line of runtime ids ("shell b7w140a81   for 45m"; maintainer 2026-08-27,
// with a screenshot: "for shells, I keep on seeing this fucking disgusting thing"). What these pin: the
// piece renders the SAME rows off the same thread data the resting card uses, the divider follows the
// prose flag, and a thread with nothing live draws nothing at all — never a heading over an empty grid,
// and never the ids.
test("AwaitingWaitTable draws the resting card's rows off a thread that is not at rest", () => {
  const midTurn = {
    ...thread([agent("running")], [shell("running")]),
    watches: [shellWatch("bzvtnt3ig"), watcher(), timerWatch()],
  } as Parameters<typeof AwaitingWaitTable>[0]["thread"]
  const html = renderToStaticMarkup(createElement(AwaitingWaitTable, { thread: midTurn, divider: true }))
  const plain = html.replace(/<[^>]+>/g, "")
  // One row per kind, grouped under the resting card's own headings, in its order.
  for (const head of ["Sub-agents", "Agent terminals", "Pull requests", "Timers"]) assert.match(plain, new RegExp(head))
  assert.ok(plain.indexOf("Sub-agents") < plain.indexOf("Agent terminals") && plain.indexOf("Agent terminals") < plain.indexOf("Pull requests") && plain.indexOf("Pull requests") < plain.indexOf("Timers"))
  // The shell row resolves its declared handle to the shell's NAME, and the id stays in data attributes.
  assert.match(html, /data-wait-row="bzvtnt3ig" data-wait-kind="shell"/)
  assert.match(plain, /vite dev/)
  assert.doesNotMatch(plain, /bzvtnt3ig/, "a runtime id is never the reader's text")
  // Its age, and no "running": every row in the group is running, as the sub-agent rows above say by not
  // saying so — and on the fullscreen page's rail that word pushed the budget into the status track's ellipsis.
  assert.doesNotMatch(plain, /running · /)
  // The divider is the caller's call — it separates prose the caller drew above.
  assert.match(html, /-mx-4 mt-3 border-t border-border/)
  assert.doesNotMatch(renderToStaticMarkup(createElement(AwaitingWaitTable, { thread: midTurn, divider: false })), /-mx-4 mt-3 border-t border-border/)
  // The resting card renders these very rows — one table, two surfaces.
  assert.match(render({ ...midTurn } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]), /data-wait-row="bzvtnt3ig" data-wait-kind="shell"/)
})

test("AwaitingWaitTable draws nothing for a thread with nothing live", () => {
  // The shell the fence named has finished (it is no longer in bgShells, so the board synthesized no
  // watch row) and the worker is working on its result: the fence card keeps its prose and gets no grid.
  const spent = { ...thread([], []), watches: [] } as Parameters<typeof AwaitingWaitTable>[0]["thread"]
  assert.equal(renderToStaticMarkup(createElement(AwaitingWaitTable, { thread: spent, divider: true })), "")
})

// THE FENCE'S OWN `shells:` ROW OFF THE HINTS (2026-08-28). The board rows a declared shell only while
// the fence is the worker's last word, and the tailer clears that on the very user record that bumps
// the thread — so `thread.watches` keeps the PR and the timer (rows in their own registries) and drops
// the shell, while the shell keeps running. The maintainer's screenshots: a three-row card at rest,
// two rows the moment they replied ("it hides the background shell for some reason").
test("a fence's shell hint rows the shell the board no longer lists", () => {
  const bumped = {
    ...thread([], [shell("running")]),
    watches: [watcher(), timerWatch()],
  } as Parameters<typeof AwaitingWaitTable>[0]["thread"]
  const hints = [{ kind: "shell" as const, value: "bzvtnt3ig" }, { kind: "for" as const, value: "2h" }]
  const html = renderToStaticMarkup(createElement(AwaitingWaitTable, { thread: bumped, divider: true, hints }))
  const plain = html.replace(/<[^>]+>/g, "")
  assert.match(html, /data-wait-row="bzvtnt3ig" data-wait-kind="shell"/, "the declared shell is a row again")
  assert.match(plain, /vite dev/, "…named by the shell, not the handle")
  for (const head of ["Agent terminals", "Pull requests", "Timers"]) assert.match(plain, new RegExp(head))
  // Without the hints the same thread draws two rows — the exact bug.
  assert.doesNotMatch(renderToStaticMarkup(createElement(AwaitingWaitTable, { thread: bumped, divider: true })), /data-wait-kind="shell"/)
  // A hint naming nothing running is not a wait: the shell finished, or the worker mistyped it. No row,
  // and never a row wearing the raw handle.
  const spent = { ...thread([], []), watches: [] } as Parameters<typeof AwaitingWaitTable>[0]["thread"]
  assert.equal(renderToStaticMarkup(createElement(AwaitingWaitTable, { thread: spent, divider: true, hints })), "")
  // At rest the board rows it too — one row, never the same shell twice.
  const atRest = { ...bumped, watches: [shellWatch("bzvtnt3ig"), watcher(), timerWatch()] } as Parameters<typeof AwaitingWaitTable>[0]["thread"]
  assert.equal(renderToStaticMarkup(createElement(AwaitingWaitTable, { thread: atRest, divider: true, hints })).match(/data-wait-kind="shell"/g)?.length, 1)
  // The resting card reads the same hints off the thread's own fence.
  const rested = { ...bumped, lastFence: { kind: "awaiting", body: "", hints } } as Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
  assert.match(render(rested), /data-wait-row="bzvtnt3ig" data-wait-kind="shell"/)
})

// THE STOP (David 2026-09-29: "there also needs to be a cancel button for background shell,
// currently only snooze"). What can silently go wrong: the button offering a stop the server said it
// cannot deliver, counting a shell the card never showed, or vanishing on a thread that has no rest to
// park but still has shells to end.
type T = Parameters<typeof AwaitingBackgroundCard>[0]["thread"]
const liveShell = (id: string, taskId: string, label: string, stoppable?: boolean) =>
  ({ id, taskId, label, startedAt: "2026-07-28T09:00:00.000Z", state: "running" as const, ...(stoppable === undefined ? {} : { stoppable }) })
const shellRest = (shells: ReturnType<typeof liveShell>[], declared: string[]) =>
  ({ ...thread([], shells), watches: declared.map(shellWatch) }) as T

test("a running, stoppable, declared shell puts Stop terminal in the footer", () => {
  const t = shellRest([liveShell("toolu_s", "bzvtnt3ig", "vite dev", true)], ["bzvtnt3ig"])
  assert.match(render(t), /data-awaiting-stop-shells="1"/)
  assert.match(text(t), /Stop terminal/)
})

test("the count follows the shells the card rows, and says so", () => {
  const two = shellRest([liveShell("toolu_a", "ba", "vite dev", true), liveShell("toolu_b", "bb", "gh run watch", true)], ["ba", "bb"])
  assert.match(text(two), /Stop 2 terminals/)
  assert.deepEqual(stoppableShellIds(two!), ["toolu_a", "toolu_b"])
  // An UNDECLARED shell running beside a declared one has no row, so it is not in the count either — a
  // "Stop 2 shells" over one visible row would end a dev server the card never showed.
  const oneRowed = shellRest([liveShell("toolu_a", "ba", "vite dev", true), liveShell("toolu_x", "bx", "some other server", true)], ["ba"])
  assert.deepEqual(stoppableShellIds(oneRowed!), ["toolu_a"])
  assert.match(text(oneRowed), /Stop terminal/)
  assert.doesNotMatch(text(oneRowed), /Stop 2 terminals/)
})

test("no stoppable running shell ⇒ no Stop, never a control that cannot deliver", () => {
  // The server's `stoppable` absent or false (a codex exec; a Claude shell before its launch ack).
  assert.doesNotMatch(render(shellRest([liveShell("toolu_s", "bzvtnt3ig", "vite dev")], ["bzvtnt3ig"])), /data-awaiting-stop-shells/)
  assert.doesNotMatch(render(shellRest([liveShell("toolu_s", "bzvtnt3ig", "vite dev", false)], ["bzvtnt3ig"])), /data-awaiting-stop-shells/)
  // A sub-agent rest has no shells at all.
  assert.doesNotMatch(render(thread([agent("running")], [])), /data-awaiting-stop-shells/)
  // Foreign and archived threads get no verbs, this one included.
  const t = shellRest([liveShell("toolu_s", "bzvtnt3ig", "vite dev", true)], ["bzvtnt3ig"])
  assert.doesNotMatch(render({ ...t, foreign: true } as T), /data-awaiting-stop-shells/)
  assert.doesNotMatch(render({ ...t, state: "archived" } as T), /data-awaiting-stop-shells/)
})

// The band is the family's shared action footer (TranscriptCard's CardActions, 2026-09-30), so the done
// card's Mark as done and every other card's verb sit in this same shape.
test("Stop rides the shared footer band, flush with the card's bottom", () => {
  const t = shellRest([liveShell("toolu_s", "bzvtnt3ig", "vite dev", true)], ["bzvtnt3ig"])
  const html = render(t)
  assert.doesNotMatch(html, /pb-0/, "the band pulls itself flush; the shell keeps its padding")
  assert.match(html, /data-awaiting-actions="true" data-card-actions="true"/, "the Stop rides the shared action footer")
  assert.match(html, /-mx-4 -mb-4 mt-3 flex[^"]*border-t border-border bg-fg/, "the band runs edge to edge under a rule")
})

// ---- STEPS FOR THE HUMAN (2026-10-03) --------------------------------------------------------------
// A fence carrying `steps:` waits on the READER. The steps themselves render through the markdown
// sanitizer, which needs a real DOM this runner does not have — the drawn card, its "Awaiting human" chip head
// and its one verb are pinned in a real browser by AwaitingSteps.e2e.test.ts (the chip head's structure
// is TranscriptCard's, in TranscriptCard.test.ts). What is DOM-free is pinned here: the one test that
// decides whether the verbs may be offered at all.
const stepHints = [{ kind: "step" as const, value: "Run `npm login`" }, { kind: "step" as const, value: "Approve the prompt" }]

test("the steps' Done is offered only while the thread rests on exactly those steps", () => {
  const steps = stepHints.map((h) => h.value)
  const resting = { runtime: "turn-idle", lastFence: { kind: "awaiting", body: "", hints: stepHints } } as Parameters<typeof restingOnSteps>[0]
  assert.equal(restingOnSteps(resting, steps), true)
  // A turn running — the human already replied, or anything else woke the worker — has nobody waiting.
  assert.equal(restingOnSteps({ ...resting, runtime: "running" } as typeof resting, steps), false)
  // The board has moved past this fence: a newer rest, or none (the tailer clears it on the reply).
  assert.equal(restingOnSteps({ ...resting, lastFence: undefined } as typeof resting, steps), false)
  assert.equal(restingOnSteps({ ...resting, lastFence: { kind: "done", body: "", hints: stepHints } } as typeof resting, steps), false)
  assert.equal(restingOnSteps(resting, [steps[0]]), false, "a card for other steps is a record, not the ask")
  assert.equal(restingOnSteps(resting, [...steps].reverse()), false)
  assert.equal(restingOnSteps(resting, []), false, "no steps, no Done")
  assert.equal(restingOnSteps(undefined, steps), false, "a sub-agent's transcript has no thread to reply to")
})

// A REST WHOSE FENCE NAMES QUESTIONS DRAWS NO RESTING CARD (2026-10-08): the question cards are its ending,
// and the live work it also names is in the ops summary beside the prompt box.
test("showsRestingCard stands down for a fence that names questions, and only for that", () => {
  const rest = (hints: { kind: string; value: string }[]) =>
    ({ awaitingBackground: true, runtime: "turn-idle", lastFence: { kind: "awaiting", body: "CI passes.", hints } }) as Parameters<typeof showsRestingCard>[0]
  const pr = { kind: "pr", value: "acme/app#1480" }
  assert.equal(showsRestingCard(rest([pr])), true, "the control: the same rest with no question keeps its card")
  assert.equal(showsRestingCard(rest([pr, { kind: "question", value: "qst_466f9d6ee188" }])), false)
  assert.equal(showsRestingCard(rest([pr, { kind: "question", value: "qst_466f9d6ee188" }, { kind: "step", value: "Run `npm login`" }])), true, "steps keep the card and its Done")
})
