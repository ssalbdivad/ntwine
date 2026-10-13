import assert from "node:assert/strict"
import test from "node:test"
import { buildWorkerPrompt } from "./workerPrompt.ts"

test("both worker backends receive the gerund activity-caption contract", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /starts with an `-ing` verb\*\*, in sentence case/)
    assert.match(prompt, /Reading src\/config\.ts/)
    // The imperative is the form that keeps slipping through, so the contract must name it and show
    // the conversion — and must forbid papering over it with a `Running` prefix.
    assert.match(prompt, /`Find relative links in the README` → `Finding relative links in the README`/)
    assert.match(prompt, /Never prefix a description with `Running`/)
  }
})

// ONE PLACE FOR WORKTREES. The contract named none until 2026-10-11, and four projects on one machine
// had four conventions, two of them outside the project. The path is also known to the server: the
// board's `.ntwine` watcher prunes `worktrees` (board.test.ts pins that list) and repo-files.ts reads a
// worktree's own ignore rules, so a contract that moves the location has to move those with it.
test("every backend sends worktrees to one directory inside the project", () => {
  for (const backend of ["claude", "codex", "acp"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /^## Git worktrees$/m)
    assert.match(prompt, /`git worktree add \.ntwine\/worktrees\/<slug> -b <slug>`/)
    assert.match(prompt, /A project that names its own worktree location or command keeps it/)
    assert.match(prompt, /never move or remove one you did not create/)
  }
  // Only Claude Code has tools that create a worktree somewhere else.
  assert.match(buildWorkerPrompt("claude"), /`EnterWorktree` and the Agent tool's\s+`isolation: "worktree"`/)
  assert.doesNotMatch(buildWorkerPrompt("codex"), /EnterWorktree/)
})

// THE CEILING, which is the counterweight to a stop criterion that otherwise only ever says "do not
// stop". Traced 2026-08-17 on `investigate-nubjs-nub-642`: dispatched to TRIAGE an issue and recommend
// what to do, it produced the analysis, asked one design question, got no answer for 36 hours, and then
// — under a Goal telling it that a written-up plan is not an ending and that unanswered calls are its own
// to make — decided the question itself and shipped seven commits, a moved global bin dir, shell-profile
// writing and a docs change. Nothing woke it but its own background completions.
//
// "Keep going" is unbounded by construction: there is always more to do in any repo, so a worker
// forbidden to stop can only stop by widening its remit. Both halves have to be in the contract.
test("the contract bounds the work to the task, not only the stopping", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /THE INSTRUCTION IS ALSO THE CEILING/)
    assert.match(prompt, /Work you notice on the way is a FINDING, not a task/)
    // An ANALYSIS job ends with its analysis. Denying that is what turned a triage into a feature branch.
    assert.match(prompt, /the document is the ending/i)
    assert.match(prompt, /Implementing what it proposes is the NEXT job/)
    // …and silence from the human is not a mandate.
    assert.match(prompt, /unanswered question is not permission to build the answer/i)
  }
})

// The placement rule's whole arc, because the contract has now taught five different things here and a
// stale assertion would resurrect the wrong one. (1) 2026-08-28 morning, "Same question showing up twice
// in a row": register-then-refence drew two cards, so the rule was "never also fence it". (2) The same
// afternoon the maintainer reversed it ("it kind of makes sense to me for the agent to decide where
// questions render in its own rest message"), and the fence became the PLACEMENT. (3) 2026-08-30 the
// maintainer retired placement ("Retire mid-prose placement" — measured: 15 of 17 real markers sat at
// the tail where the card lands anyway, 2 of 3,005 transcripts couched one mid-prose). (4) 2026-09-11 the
// FREE-FORM fence was retired outright — `ask` had been "better than a fenced block" since 2026-08-26
// while the contract went on teaching the fence, so workers wrote fences on every day from 2026-08-25 to
// 2026-09-11, and nothing tracks a fence's answer — and the empty placement marker came BACK with it,
// because a marker references a ROW: nothing about a question's lifecycle is guessed from prose. (5)
// 2026-09-28 the marker went again, for good reason this time: taught to place the card "after the
// paragraph that sets it up, before the one that says what happens either way", workers put prose under
// it — 7 of 15 real markers — and the maintainer: "questions should always appear at the bottom of the
// thread not in the middle any explanation should occur beforehand". The card draws itself at the bottom
// of the handoff, the contract teaches writing the explanation FIRST, and it must still teach the
// withdrawal — a question left out of the write-up is still open and still gates `done`. (6) 2026-10-06
// the contract stopped claiming the marker "draws nothing": the web never stopped rendering it (its
// questionShadow.ts is upstream's), so the contract says what a marker does and tells the worker to write
// none (plans/upstream-superset.md §3).
test("the contract teaches that a registered question draws itself at the bottom, and how to unask one", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    const c = prompt.replace(/\s+/g, " ")
    assert.match(prompt, /EVERY OPEN QUESTION DRAWS ITS OWN CARD AT ITS REST/)
    assert.match(prompt, /draws NOTHING: one question, one card/)
    // The card is last, so the explanation is first — said where the worker asks AND where it stops.
    assert.match(c, /THE CARD IS THE LAST THING THE USER READS — PUT EVERY WORD OF EXPLANATION BEFORE IT/)
    assert.match(c, /ntwine draws the question at the BOTTOM of the handoff of the rest that asked it, below its last line/)
    // A question stays at the rest that asked it (upstream 2026-10-05) — a later rest names it under
    // `questions:` or withdraws it, said once, where the worker stops. A typed message changes nothing
    // about it: it stays open until it is answered, dismissed or withdrawn. The refusal of a re-ask is
    // `ask`'s own (its description and its refusal say so), so the contract does not restate it.
    assert.match(c, /AT EVERY LATER REST, SAY WHERE EACH OLD QUESTION STANDS/)
    assert.match(c, /A QUESTION STAYS OPEN UNTIL IT IS ANSWERED, THE USER DISMISSES IT, OR YOU WITHDRAW IT/)
    assert.match(c, /A message\s+the user types instead of answering does not close it/)
    assert.doesNotMatch(c, /SETS IT ASIDE|`keep`|mcp__ntwine__keep/)
    assert.doesNotMatch(c, /A REPLY PAST A QUESTION IS A PIVOT/)
    assert.doesNotMatch(c, /`unask` the old id and `ask` again/)
    // Answers come a question at a time, so the worker must act on each as it lands — the reason the
    // questions of one `ask` must be independent.
    assert.match(c, /ANSWERS ARRIVE ONE QUESTION AT A TIME/)
    assert.doesNotMatch(c, /send as one batch/)
    // Leaving one out is not how a worker drops it — that is what `unask` is for.
    assert.match(prompt, /it is one you\s+`unask`/)
    // The 2026-08-28 grammar ("place them all, or unask") must stay gone, and so must the couching.
    assert.doesNotMatch(prompt, /PLACE EVERY OPEN QUESTION/)
    assert.doesNotMatch(prompt, /A REGISTERED QUESTION IS NEVER ALSO FENCED/)
    assert.doesNotMatch(c, /before the one that says what happens either way/)
  }
})

// THE FREE-FORM ```question FENCE IS RETIRED (2026-09-11), and the contract has to say so where a worker
// reads it — both in § Questions for the human and in the End-of-turn signals list, which is what a
// worker reads when it STOPS. Since 2026-09-28 the contract teaches no placement marker either, so it
// carries no ```question fence of any shape — but the web still RENDERS a marker (upstream's
// questionShadow.ts, kept on purpose), so the contract must not claim one draws nothing (2026-10-06).
test("the contract teaches ask as the only way to ask, and no question fence at all — not even the marker", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    const c = prompt.replace(/\s+/g, " ")
    assert.match(c, /THERE IS NO `question` FENCE ANY MORE/)
    assert.match(c, /A QUESTION HAS NO FENCE ANY MORE/)
    assert.match(c, /WAITING ON A PERSON TO DECIDE IS A REGISTERED QUESTION/)
    assert.match(c, /AN OPEN REGISTERED QUESTION IS THE HANDBACK/)
    // No fenced question of any shape — neither one with a body nor the retired empty marker.
    assert.deepEqual(prompt.match(/```question[^\n]*\n/g) ?? [], [])
    assert.doesNotMatch(c, /TO PLACE A QUESTION INSIDE YOUR PROSE/)
    assert.doesNotMatch(c, /Placement is OPTIONAL/)
    assert.doesNotMatch(c, /One marker per question/)
    assert.doesNotMatch(c, /PLACEMENT marker is not a signal block/)
    // And the free-form teaching is gone in every spelling it had.
    assert.doesNotMatch(c, /put each question in its own fenced `question` block/)
    assert.doesNotMatch(c, /Fence a question you did NOT register/)
    assert.doesNotMatch(c, /```question ` block IS the handback/)
    assert.doesNotMatch(c, /was retired 2026-08-30;\s*a marker you still write draws nothing/)
    // What the UI actually does with a marker, and the fork's advice: write none.
    assert.doesNotMatch(c, /placement marker any more|empty question fence naming an id draws nothing/)
    assert.match(c, /A placement marker — an empty `question` fence naming an id — draws the card where the fence sits instead\. Write none/)
    assert.doesNotMatch(c, /surface it as a ` ```question `/)
    assert.doesNotMatch(c, /ask a ```question/)
  }
})

// Traced 2026-09-30 on the `yes` repo's `releaseNext`: asked "what are the best next priorities before
// standup", the worker ranked them in its THINKING, called `done` with a ledger bullet reading "Ranked the
// next items", and closed on "The priorities are ranked above." The human saw no ranking, and the card it
// pointed "above" at rendered below. The ledger/prose split had squeezed the actual answer out of both.
test("the contract puts a question's answer in the prose, and the card below it", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.match(prompt, /THE ANSWER IS THE PROSE — IN FULL, IN THE MESSAGE/)
    assert.match(prompt, /the user never\s+sees your thinking/)
    assert.match(prompt, /renders\s+BELOW your last message/)
  }
})

// A worker drafted an issue in its handoff and asked whether to post "the draft (above)"; the queue card
// showed that prose clipped to a few lines, so the human was asked to approve something they could not
// see (David 2026-10-06). The draft belongs inside the option that posts it.
test("the contract puts a draft being approved inside the option that sends it", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend).replace(/\s+/g, " ")
    assert.match(prompt, /THE USER SEES THE CARD, NOT YOUR MESSAGE — SO WHAT THEY DECIDE ON GOES IN THE CARD/)
    assert.match(prompt, /Never write "above" or "below" in a question/)
    assert.doesNotMatch(prompt, /Leave it in the handoff/)
  }
})

// A worker asked "can you see the highlighted code?" answered that it could not: a command it has never
// heard named is one it never reaches for, so `ntwinectl editor` reaches it only if the contract names it,
// with the words that should make it reach for it. Since 2026-10-06 that holds while an editor has the
// project open — the only time the MCP mount lists the tool (ntwine-mcp GATED_TOOLS) — and otherwise the
// contract does not name it at all.
// The section is the ONLY difference the capability makes: spliced out, the contract is the default one
// byte for byte, so the goldens (which pin the default) still pin every other word of the gated build.
test("every backend's contract names the editor tool, and when to call it, only while an editor is open", () => {
  for (const backend of ["claude", "codex", "acp"] as const) {
    const withEditor = buildWorkerPrompt(backend, { editor: true })
    const without = buildWorkerPrompt(backend)
    assert.match(withEditor.replace(/\s+/g, " "), /When the user points at code they have not pasted — "this", "the selected code", "the error" — run `ntwinectl editor`/)
    assert.doesNotMatch(without, /ntwinectl editor|## The (?:user|human)'s editor/)
    assert.equal(buildWorkerPrompt(backend, { editor: false }), without)
    const section = withEditor.slice(withEditor.indexOf("## The user's editor"), withEditor.indexOf("\n\n## ", withEditor.indexOf("## The user's editor")))
    assert.equal(withEditor.replace(`\n\n${section}`, ""), without)
  }
})

// STEPS FOR THE HUMAN (2026-10-03) ride the awaiting fence, and the contract has to route to them at the
// places a worker decides how to hand over — or "what the human must do" stays a sentence in a handoff
// that nothing tracks and nothing wakes on.
test("the contract teaches steps: as the wait on a human's act, and routes to it where a worker hands over", () => {
  for (const backend of ["claude", "codex"] as const) {
    const prompt = buildWorkerPrompt(backend)
    const c = prompt.replace(/\s+/g, " ")
    // Taught by example, in the grammar the parser reads: one `- ` item per step under the key.
    assert.match(prompt, /```awaiting\n {2}title: Approve the npm sign-in so the release can publish\n {2}steps:\n {4}- Open \[the npm sign-in this thread started\]/)
    // Its properties: verbatim, names the human (so no other name and no `for:`), always queues, and its
    // one verb comes back as the human's own reply — anything else is a message of their own.
    assert.match(c, /The `title:` and `steps:` values are the exceptions: ntwine reads them verbatim/)
    assert.match(c, /Steps NAME THE USER as the wait, so the fence needs no other name and no `for:`/)
    assert.match(c, /it always puts the thread in their queue/)
    assert.match(c, /anything else they need to tell you — a step that failed, the account they used — comes as a message of their own/)
    assert.doesNotMatch(c, /Couldn't do it/)
    assert.match(c, /\(`steps:` and `questions:` count: they name the user\.\)/)
    // Every step is clickable and complete (maintainer 2026-10-08): links to the pages it names, taught
    // by a bad/good pair, and the example fence itself carries a link.
    assert.match(c, /EVERY STEP IS CLICKABLE AND COMPLETE — A STEP THAT MAKES THE USER GO LOOKING IS A BROKEN STEP/)
    assert.match(c, /every page it names is a real Markdown link to that exact page/)
    assert.match(c, /Good: `Open the \[Ntwine account audit log\]\(https:\/\/dash\.cloudflare\.com\/<account-id>\/audit-log\)/)
    assert.match(prompt, /steps:\n {4}- Open \[the npm sign-in this thread started\]\(https:\/\/www\.npmjs\.com\/login\?next=\/login\/cli\/9f3c2a71\)[^\n]*\n {4}- /)
    // THE FIRST TEST (maintainer 2026-10-10): a step is only what the worker cannot do itself. It sits
    // AHEAD of clickable-and-complete, and the example fence obeys it — the command is the worker's, run
    // already, and no step tells the human to run one.
    assert.match(c, /THE FIRST TEST OF EVERY STEP: COULD YOU DO IT YOURSELF\? THEN IT IS NOT A STEP — DO IT\./)
    assert.ok(c.indexOf("THE FIRST TEST OF EVERY STEP") < c.indexOf("EVERY STEP IS CLICKABLE AND COMPLETE"), "the residue test comes first")
    assert.match(c, /A step is only what needs the user's BODY or the user's IDENTITY/)
    assert.match(c, /do everything up to the first one, hand over only that, and do what follows yourself when their reply wakes you/)
    assert.match(c, /`npm login --auth-type=web` is running in this thread and waiting on that approval/)
    assert.doesNotMatch(prompt, /steps:\n(?: {4}- [^\n]*\n)*? {4}- Run `npm login/)
    assert.match(c, /card, headed \*\*Awaiting human\*\*, shows the steps over one \*\*Done\*\* button, and its click comes back to you as their reply, `Done`/)
    // A decision is still a question; an act is steps — at every place the two used to blur.
    assert.match(c, /A DECISION you need from them is a question, never a fence/)
    assert.match(c, /WAITING ON ONE TO ACT IS `steps:`/)
    assert.match(c, /Once nothing is left to DECIDE and only the user's act remains, the steps go to them under `steps:`/)
    assert.match(c, /Something the user must DO \("re-pull before you restart"\) is not a dangling idea either: hand it to them under `steps:`/)
    assert.doesNotMatch(c, /that is the handoff, and it belongs in the prose/)
    // And the registered first cut is gone from the contract entirely.
    assert.doesNotMatch(c, /mcp__ntwine__instruct|\buninstruct\b/)
  }
})

// COMMAND WATCHES ARE CLAUDE-ONLY (2026-10-11). The server refuses every Codex and ACP thread one
// (command-watch.ts `commandWatchRefusal`), so only Claude's contract may teach the key, the week-long
// ceiling and the route to it; anywhere else each mention is a refused call per wait. Claude's must
// also say why a polling shell is the wrong wait, and where the loop goes when Ntwine refuses.
test("only the Claude contract teaches command watches, and it routes outside-condition waits to them", () => {
  const claude = buildWorkerPrompt("claude")
  assert.match(claude, /`commands:` — command watches you REGISTERED with `ntwinectl watch-command add`/)
  assert.match(claude, /`commands:` with nothing but those, where it runs to a week/)
  assert.match(claude, /`ntwinectl watch-command add "<check that exits 0 once it holds>" --every 5m --for 6h`/)
  assert.match(claude, /Not a polling loop in a background shell/)
  assert.match(claude, /can never be hibernated/)
  assert.match(claude, /Only when Ntwine REFUSES it[\s\S]{0,140}does the loop go in a background shell/)
  for (const backend of ["codex", "acp"] as const) {
    const prompt = buildWorkerPrompt(backend)
    assert.doesNotMatch(prompt, /watch-command|commands:|cmw_/, backend)
    assert.doesNotMatch(prompt, /\{\{NTWINE_/, backend)
    assert.match(prompt, /where it runs to a year — and at 30 minutes/, backend)
    assert.match(prompt, /`ntwinectl watch-issue`\.\n    For anything else stay ACTIVE/, backend)
  }
})
