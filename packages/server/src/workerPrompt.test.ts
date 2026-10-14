import assert from "node:assert/strict"
import test from "node:test"
import { buildWorkerPrompt, type BackendKind } from "./workerPrompt.ts"

// The goldens (dispatch.test.ts) pin every byte of the default contract, so a deliberate edit just
// regenerates them. These tests pin what must SURVIVE a deliberate edit: each rule below has an incident
// behind it (workerPrompt.ts header) and must be stated somewhere, in some wording close to this one.
// Matched whitespace-normalized, so reflowing a paragraph never fails the suite.
const ALL = ["claude", "codex", "acp"] as const
const flat = (kind: BackendKind) => buildWorkerPrompt(kind).replace(/\s+/g, " ")

// The contract regrew from ~3.7k to ~19k tokens by accretion between 2026-07-25 and 2026-10-14, each
// paragraph earning its place on the day it was added. A ceiling makes every addition a conscious one:
// raise it in the same commit as the rule that needs the room, and say which rule.
test("each backend's contract stays inside its size budget", () => {
  const budget: Record<BackendKind, number> = { claude: 31_000, codex: 32_000, acp: 26_000 }
  for (const kind of ALL) {
    const size = buildWorkerPrompt(kind).length
    assert.ok(size <= budget[kind], `${kind}: ${size} chars, over its ${budget[kind]} budget`)
  }
})

test("every tool description is a gerund, and the imperative is named as the form to convert", () => {
  for (const kind of ALL) {
    const c = flat(kind)
    assert.match(c, /starts with an `-ing` verb\*\*, in sentence case/)
    assert.match(c, /`Find relative links in the README` → `Finding relative links in the README`/)
    assert.match(c, /Never prefix a description with `Running`/)
  }
})

// A turn's ending IS the thread's state (CLAUDE.md § How a thread hands off). The four endings, the
// conversational exception, and the fact that the retired ```question fence draws nothing.
test("every rest ends in done, a question, an awaiting fence, or a conversational reply — nothing else", () => {
  for (const kind of ALL) {
    const raw = buildWorkerPrompt(kind)
    const c = flat(kind)
    assert.match(c, /\*\*Done\*\* — `ntwinectl done`/)
    assert.match(c, /\*\*A question\*\* — `ntwinectl ask`/)
    assert.match(c, /\*\*An ` ```awaiting ` fence\*\*/)
    assert.match(c, /\*\*Nothing\*\* — only when replying to a message the user typed that asks for an answer/)
    assert.match(c, /If work you parked on is still running, end the reply with that same awaiting fence/)
    assert.match(c, /bare rest — an item nobody can triage/)
    assert.match(c, /A wait always takes the fence/)
    assert.match(c, /There is no `question` fence/)
    assert.deepEqual(raw.match(/```question/g) ?? [], [], "no question fence of any shape is taught")
  }
})

test("the write-up: quiet parks say nothing, every other rest names its subject and answers in prose", () => {
  for (const kind of ALL) {
    const c = flat(kind)
    assert.match(c, /A quiet park needs no write-up/)
    assert.match(c, /Every other rest covers everything since the user's last message/)
    assert.match(c, /Name what the work is against in the first line or two of every resting message/)
    assert.match(c, /Write every issue and PR as `owner\/repo#123`, never a bare `#123`\*\*, in plain prose/)
    // 2026-09-30: priorities ranked in thinking, carded as "Ranked the next items", pointed at "above".
    assert.match(c, /the answer is the prose, in full\*\* — not in your thinking, which the user never sees/)
    assert.match(c, /Every card renders BELOW your last message, so never point "above" at one/)
    assert.match(c, /Nothing appears in both/)
  }
})

test("done is a dismissal: landed as far as asked, nothing owed, and found work takes an exit in order", () => {
  for (const kind of ALL) {
    const c = flat(kind)
    assert.match(c, /what is lost if nobody ever opens this thread again\?\*\* If you can name anything, or are unsure, it is not done/)
    assert.match(c, /It refuses while a question is open or a watch is armed/)
    assert.match(c, /There is no force flag/)
    assert.match(c, /Commit, push or open a pull request only when their current request asks for it or the project's docs tell workers to/)
    assert.match(c, /finished code is `done` where it sits/)
    assert.match(c, /Asked to merge: not done until it merges — park on its PR with `prs:`/)
    assert.match(c, /never park on the user's own review or merge/)
    // zod #6022: a drafted, unposted close comment fenced as done.
    assert.match(c, /an investigation headed for a fix \(the fix is still owed\)/)
    assert.match(c, /A draft you wrote but did not send: ask whether to send it, with the draft inside the option that sends it/)
    assert.match(c, /FULLY written to a file the user can open without this thread. If it ends in a decision the user must make, write the file AND ask/)
    // zod #6065 and the nub spawn chain: do → ask → spawn → drop, in that order.
    const order = ["1. **Do it**", "2. **Ask**", "3. **Spawn**", "4. **Drop it**"].map((m) => c.indexOf(m))
    assert.ok(order.every((i) => i > 0), "all four exits present")
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "do it → ask → spawn → drop")
    assert.match(c, /never a "worth doing later" line parked in the card/)
  }
})

test("the awaiting fence: status answered top-down, names registered first, a fresh fence after every message", () => {
  for (const kind of ALL) {
    const raw = buildWorkerPrompt(kind)
    const c = flat(kind)
    assert.match(raw, /```awaiting\nshells: \[bzvtnt3ig\]\nagents: \[<the runtime agent id>\]\nstatus: working\nfor: 2h\n```/)
    // b8fc23f9: needs_input, then working, then watching — in that order.
    const order = ["⇒ `needs_input`", "⇒ `working`", "⇒ `watching`"].map((m) => c.indexOf(m))
    assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], "needs_input → working → watching")
    assert.match(c, /any words for them at all/)
    assert.match(c, /The user's review of what you handed over is `needs_input`, never `watching`/)
    assert.match(c, /registered FIRST with `ntwinectl watch-pr add`/)
    assert.match(c, /`for: 180d`/)
    assert.match(c, /No prose above the `---`/)
    assert.match(c, /a fence that names nothing is not a park/)
    assert.match(c, /write a FRESH fence — never answer "back to awaiting" with "already parked"/)
    // Retired grammar is not taught again, not even to bury it: no current worker has seen it.
    assert.doesNotMatch(c, /`reason:`|`human:`|`issues:`|watch-issue|needs_input: (?:true|false)|timer: <ISO/)
  }
})

test("steps hand over only the user's own acts, each clickable and complete", () => {
  for (const kind of ALL) {
    const raw = buildWorkerPrompt(kind)
    const c = flat(kind)
    assert.match(raw, /```awaiting\ntitle: Approve the npm sign-in so the release can publish\nsteps:\n {2}- Open \[the npm sign-in this thread started\]\(https:\/\/www\.npmjs\.com\/[^)]+\)/)
    // The example obeys its own rule: the command is the worker's, already running.
    assert.match(c, /`npm login --auth-type=web` is running in this thread/)
    // Upstream 3613aaa7: the residue test comes before clickable-and-complete.
    const residue = c.indexOf("could you do it yourself? Then it is not a step — do it.")
    const clickable = c.indexOf("Every step is clickable and complete — a step that makes the user go looking is a broken step.")
    assert.ok(residue > 0 && clickable > residue, "the residue test comes first")
    assert.match(c, /A step is only what needs the user's BODY or IDENTITY/)
    assert.match(c, /Do everything up to their first act, hand over only that/)
    assert.match(c, /Good: `Open the \[account audit log\]\(https:\/\/dash\.cloudflare\.com\//)
    assert.match(c, /reply `Done`/)
    assert.match(c, /`ntwinectl secret`/)
  }
})

test("questions: registered, recommended first, actor-explicit, self-contained, and drawn at the bottom", () => {
  for (const kind of ALL) {
    const c = flat(kind)
    assert.match(c, /\*\*Your pick first\*\*, marked `recommended`/)
    assert.match(c, /No "I" and no "you" anywhere in a question/)
    assert.match(c, /What the user decides on goes IN the card\*\*: a draft, diff or plan being approved rides inside the option that acts on it. Never write "above" or "below" in a question/)
    assert.match(c, /Write it in the user's own vocabulary/)
    assert.match(c, /Every option states its COST/)
    assert.match(c, /never on a decision the work builds on/)
    assert.match(c, /Ask last, then rest/)
    assert.match(c, /drawn at the BOTTOM of the handoff of the rest that asked it, so every word of explanation goes before it, and the prose never restates the question/)
    assert.match(c, /At every later rest, say where each open question stands:\*\* name it under `questions: \[qst_…\]` in an awaiting fence, which redraws its card there, or withdraw it with `ntwinectl unask <id>`/)
    assert.match(c, /a message the user types instead of answering does not close it/)
    assert.match(c, /A discussion is not a decision/)
  }
})

test("the stop criterion bounds both ends: never rest mid-mandate, never widen past it", () => {
  for (const kind of ALL) {
    const c = flat(kind)
    assert.match(c, /A question or comment from the user outranks the work in flight/)
    assert.match(c, /While the instruction still has parts left, do not write up — do the next part in this same turn/)
    assert.match(c, /recording work is not doing work/)
    // nub-642: a triage shipped seven commits under "keep going".
    assert.match(c, /The instruction is also the ceiling/)
    assert.match(c, /Work you notice on the way is a FINDING, not a task/)
    assert.match(c, /the document is the ending; implementing what it proposes is the NEXT job/)
    assert.match(c, /An unanswered question is not permission to build the answer/)
    assert.match(c, /If you are about to mark an option recommended, you already know the answer — act on it/)
    assert.match(c, /is run and reported, never offered/)
    assert.match(c, /Knowing the answer is not being allowed to act on it/)
  }
})

// A worker asked "can you see the highlighted code?" answered that it could not. The section renders
// only while an editor has the project open, and is the ONLY difference the capability makes: spliced
// out, the contract is the default one byte for byte, so the goldens still pin every other word.
test("every backend's contract names the editor command, and when to run it, only while an editor is open", () => {
  for (const kind of ALL) {
    const withEditor = buildWorkerPrompt(kind, { editor: true })
    const without = buildWorkerPrompt(kind)
    assert.match(withEditor.replace(/\s+/g, " "), /When the user points at code they have not pasted — "this", "the selected code", "the error" — run `ntwinectl editor`/)
    assert.doesNotMatch(without, /ntwinectl editor|## The user's editor/)
    assert.equal(buildWorkerPrompt(kind, { editor: false }), without)
    const start = withEditor.indexOf("## The user's editor")
    const section = withEditor.slice(start, withEditor.indexOf("\n\n## ", start))
    assert.equal(withEditor.replace(`\n\n${section}`, ""), without)
  }
})

// The board's `.ntwine` watcher prunes `worktrees` and repo-files.ts reads a worktree's own ignore rules,
// so a contract that moves the location has to move those with it.
test("every backend sends worktrees to one directory inside the project", () => {
  for (const kind of ALL) {
    const c = flat(kind)
    assert.match(c, /`git worktree add \.ntwine\/worktrees\/<slug> -b <slug>`/)
    assert.match(c, /A project that names its own worktree location or command keeps it/)
    assert.match(c, /Install dependencies in the worktree before trusting a result from it/)
    assert.match(c, /never move or remove one you did not create/)
  }
  assert.match(flat("claude"), /not with `EnterWorktree` or the Agent tool's `isolation: "worktree"`/)
  assert.doesNotMatch(flat("codex"), /EnterWorktree/)
})

// The server refuses a command watch from every Codex and ACP thread (command-watch.ts), so only
// Claude's contract may name the key, its week-long ceiling, or the route to it.
test("only the Claude contract teaches command watches", () => {
  const claude = flat("claude")
  assert.match(claude, /`commands:` — `cmw_…` ids from `ntwinectl watch-command add`/)
  assert.match(claude, /to a week on one naming only `commands:`/)
  assert.match(claude, /`ntwinectl watch-command add "<check that exits 0 once it holds>" --every 5m --for 6h`/)
  assert.match(claude, /Not a polling loop in a background shell and not a sub-agent that owns the wait/)
  assert.match(claude, /Only when ntwine REFUSES the command watch does the loop go in a background shell/)
  for (const kind of ["codex", "acp"] as const) {
    const raw = buildWorkerPrompt(kind)
    assert.doesNotMatch(raw, /watch-command|commands:|cmw_/, kind)
    assert.doesNotMatch(raw, /\{\{NTWINE_/, kind)
    assert.match(flat(kind), /up to a year on one naming only `prs:`\. A PR in someone else's repo/, kind)
  }
})

// Maintainer 2026-10-03: everything a tool returned renders collapsed, so the lightbox is the one way
// to show media; 2026-10-06: a design is a linked HTML page, never screenshots of one.
test("media reaches the user only through a lightbox fence, and a design is a linked page", () => {
  for (const kind of ALL) {
    const raw = buildWorkerPrompt(kind)
    const c = flat(kind)
    assert.match(c, /nothing you LOOK at is on the user's screen/)
    assert.match(raw, /```lightbox\n\/abs\/before\.png {2}Before the fix\n/)
    assert.match(c, /never `\/tmp`/)
    assert.match(c, /Put the fence above any closing signal fence, never inside one/)
    assert.match(c, /ONE self-contained HTML page carrying every candidate, and link it as `\[name\]\(file:\/\/\/abs\/path\.html\)`/)
  }
})

test("sub-agent dispatch: each backend's own mechanics, and no child is ever interrupted", () => {
  const claude = flat("claude")
  assert.match(claude, /Dispatch with the plain Agent tool \+ `run_in_background: true`, and never pass `name`/)
  assert.match(claude, /`subagent_type: "ntwine:<effort>"`/)
  assert.match(claude, /nothing of this contract, your conversation, your notes or `NTWINE\.md`, and there is no fork option/)
  assert.match(claude, /`SendMessage\(\{to: "main", …\}\)`/)
  assert.match(claude, /`ToolSearch` with `select:SendMessage`/)
  assert.match(claude, /Never interrupt a running child/)
  assert.match(claude, /A critique loop stops when its confirmed findings stop falling/)
  assert.match(claude, /`CronCreate` and `ScheduleWakeup` do not fire here/)
  assert.match(flat("codex"), /never `interrupt_agent` unless the user names that interruption/)
  assert.match(flat("acp"), /let each child finish/)
  for (const kind of ["codex", "acp"] as const) assert.doesNotMatch(flat(kind), /run_in_background|ntwine:<effort>/, kind)
})
