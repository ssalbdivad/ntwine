import { after, test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, execSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { codexScratchpadHookConfig } from "./dispatch.ts"

// ---- scratch-directory hook (cc-worker/hooks/scratchpad.mjs) ----
// Keeps a worker aware of its per-thread scratch DIRECTORY and re-orients it there when the context is
// lost: it names what is in the directory after a compaction/resume, tells the summarizer those files
// exist, and nudges when the context has moved on since the last write. These tests EXECUTE the real
// hook the way Claude Code does — argv flags, a JSON event on stdin, output on stdout — rather than
// asserting on its source, because the whole value of the hook is its wire behavior. Verified live
// against cli 2.1.220 as well: a real session quoted injected text with zero tool calls,
// `PreCompact:manual` logged status 0, and PostToolUse additionalContext reached the model mid-turn.
//
// IT POINTS, IT NO LONGER INJECTS. Until 2026-08-06 ntwine provisioned one canonical `scratch.md` and
// this hook spliced its head into the emptied window. The maintainer replaced that with a free-form
// directory plus the recurring prompt's post_compaction trigger, so the guaranteed channel is now
// something the WORKER arms and the OPERATOR can see. What the hook still owes is the listing — and
// the test below pins that it is a listing and never the content.

const here = dirname(fileURLToPath(import.meta.url))
const HOOK = join(here, "../../../cc-worker/hooks/scratchpad.mjs")
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

function newProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "scratchpad-hook-"))
  mkdirSync(join(dir, ".ntwine", "threads", SID), { recursive: true })
  return dir
}

function scratchPath(dir: string, name = "notes.md"): string {
  return join(dir, ".ntwine", "threads", SID, name)
}

/** Write one file into the thread's scratch directory. The worker chooses these names; nothing in
 *  ntwine reserves one, so the tests use several to prove the hook does not privilege any. */
function writeScratch(dir: string, body: string, name = "notes.md"): void {
  writeFileSync(scratchPath(dir, name), body)
}

// A transcript whose newest usage record reports `tokens` of context fill — the same shape Claude
// Code writes (`input + cache_creation + cache_read`), which is what the nudge reads.
function writeTranscript(dir: string, tokens: number): string {
  const path = join(dir, "transcript.jsonl")
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: tokens - 1002 }
  writeFileSync(
    path,
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) +
      "\n" +
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage } }) +
      "\n"
  )
  return path
}

function runHook(
  dir: string,
  args: string[],
  event: Record<string, unknown>,
  env: Record<string, string> = {}
): string {
  return execFileSync("node", [HOOK, ...args], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: dir,
      NTWINE_THREAD: "",
      NTWINE_SCRATCHPAD_HOOK: "",
      // An Ntwine worker running this suite carries its own board root (Home's state dir), and the hook
      // honours it over CLAUDE_PROJECT_DIR — so the hook looked for these fixtures' scratch files in the
      // worker's board and every case below failed, only when the suite ran inside an Ntwine thread.
      NTWINE_BOARD_ROOT: "",
      ...env,
    },
  })
}

function additionalContext(stdout: string): string {
  return JSON.parse(stdout).hookSpecificOutput.additionalContext as string
}

test("a fresh startup offers the directory and names the goal capability without pushing it", () => {
  const dir = newProject()
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "startup" }))
  assert.match(ctx, /⟦scratch directory⟧/)
  assert.match(ctx, /nothing in it is read automatically/)
  // The capability stays NAMED — the worker can arm it — but it is offered, never prescribed
  // (maintainer 2026-08-28: stop pushing the notes-plus-arming arrangement).
  assert.match(ctx, /`ntwinectl goal start --post-compaction`/)
  assert.match(ctx, /Use it if you want it/)
  assert.doesNotMatch(ctx, /then arm|write the doc/, "the arrangement is offered, never pushed")
})

test("after a compaction the hook NAMES the scratch files and never injects their content", () => {
  const dir = newProject()
  // Content that would be unmistakable if it leaked into the injection.
  writeScratch(dir, "UNMISTAKABLE-BODY-TEXT\n".repeat(40), "plan.md")
  writeScratch(dir, "reviewer findings", "reviewer.md")
  // ntwine's own per-thread bookkeeping lives in the same directory and is NOT the worker's notes.
  writeFileSync(scratchPath(dir, ".scratchpad-state.json"), "{}")
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))

  assert.match(ctx, /⟦scratch directory⟧/)
  assert.match(ctx, new RegExp(`\\.ntwine/threads/${SID}/plan\\.md`))
  assert.match(ctx, new RegExp(`\\.ntwine/threads/${SID}/reviewer\\.md`))
  // THE LOAD-BEARING ASSERTION. Naming is the accepted cost of dropping the canonical pad; quietly
  // re-growing this back into a content injection would restore exactly what was removed.
  assert.doesNotMatch(ctx, /UNMISTAKABLE-BODY-TEXT/, "a listing, never the content")
  assert.doesNotMatch(ctx, /scratchpad-state/, "ntwine's own bookkeeping is not the worker's notes")
  // And it still names the post-compaction goal as an available capability.
  assert.match(ctx, /`ntwinectl goal start --post-compaction`/)
})

test("a fresh startup does not pay for the listing — only the context-losing sources get it", () => {
  const dir = newProject()
  writeScratch(dir, "real notes here\n", "plan.md")
  const startup = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "startup" }))
  assert.doesNotMatch(startup, /plan\.md/, "a brand-new session has lost nothing to re-orient on")
  for (const source of ["compact", "resume", "clear"]) {
    const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source }))
    assert.match(ctx, /plan\.md/, `${source} has lost context and must be told what it left itself`)
  }
})

// Claude Code opens EVERY compaction summary with the fixed sentence "This session is being continued
// from a previous conversation that ran out of context." It is about the conversation just summarized,
// but it arrives when the window is emptiest and workers read it as a report on themselves and wind
// down — nub session 5258ebe4 took its auto-compaction at transcript line 20239 and then declared
// "I'm out of context" on 13 consecutive turns at fills of 176k-244k. This hook is the only ntwine text
// that lands in that exact window, so it is where the preamble gets answered. Pinned on BOTH pad
// states, because a compacted worker with an empty pad is the one least able to argue with it.
test("a compaction re-ground contradicts the summary's 'ran out of context' preamble", () => {
  // Pinned on BOTH directory states — a compacted worker that left itself nothing is the one least
  // able to argue with the preamble.
  for (const write of [true, false]) {
    const dir = newProject()
    if (write) writeScratch(dir, "the approach and why\n", "plan.md")
    const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
    assert.match(ctx, /ran out of context/, "the preamble is quoted so the worker knows what is being corrected")
    assert.match(ctx, /this window is close to EMPTY again/)
    assert.match(ctx, /compact and continue as many times as the effort needs/)
    assert.match(ctx, /not a reason to wind down, hand off, or leave the next step to a fresh session/)
  }
})

test("only a COMPACT start answers the preamble — a resume never saw one", () => {
  const dir = newProject()
  writeScratch(dir, "the approach and why\n", "plan.md")
  for (const source of ["resume", "clear"]) {
    const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source }))
    assert.match(ctx, /⟦scratch directory⟧/, `${source} still re-orients`)
    assert.doesNotMatch(ctx, /ran out of context/, `${source} gets no compaction summary, so there is nothing to correct`)
  }
})

test("precompact emits PLAIN stdout (never JSON) so it reaches the summarizer's instructions", () => {
  const dir = newProject()
  writeScratch(dir, "the approach and why\n", "plan.md")
  const out = runHook(dir, ["--mode=precompact"], { session_id: SID, trigger: "auto" })
  assert.match(out, /plan\.md/, "the summarizer is told the file exists so it can carry the path forward")
  assert.doesNotMatch(out, /the approach and why/, "the summarizer gets the path, not the prose")
  // Emitting JSON here would hand the summarizer a blob of JSON as its literal instructions.
  assert.throws(() => JSON.parse(out), "precompact output must not be JSON")
  assert.doesNotMatch(out, /hookSpecificOutput/)
})

test("precompact is silent when the worker wrote nothing", () => {
  const dir = newProject()
  assert.equal(runHook(dir, ["--mode=precompact"], { session_id: SID, trigger: "auto" }), "")
})

test("a large directory is summarized rather than listed line by line", () => {
  const dir = newProject()
  for (let i = 0; i < 12; i++) writeScratch(dir, "x", `note-${i}.md`)
  const ctx = additionalContext(
    runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }, { NTWINE_SCRATCH_MAX_LISTED: "5" })
  )
  assert.match(ctx, /…and 7 more/, "a worker with many files needs the count, not every line")
  assert.equal((ctx.match(/note-\d+\.md/g) ?? []).length, 5)
})

test("every silence gate holds: project registration under ntwine, sub-agents, and the kill switch", () => {
  const dir = newProject()
  writeScratch(dir, "should never appear\n", "plan.md")
  const evt = { session_id: SID, source: "compact" }
  // The repo-local `.claude/settings.json` copy defers to the plugin one inside an ntwine worker.
  assert.equal(runHook(dir, ["--mode=session-start", "--via=project"], evt, { NTWINE_THREAD: "t" }), "")
  assert.notEqual(runHook(dir, ["--mode=session-start", "--via=project"], evt), "")
  // Sub-agents do not get root re-ground/nudge injections; their dedicated start epilogue owns the
  // collaborative editing contract instead.
  assert.equal(runHook(dir, ["--mode=session-start"], { ...evt, agent_id: "sub-1" }), "")
  assert.equal(runHook(dir, ["--mode=session-start"], evt, { NTWINE_SCRATCHPAD_HOOK: "off" }), "")
  // …but a non-off value never disables it: absence means ON now.
  assert.notEqual(runHook(dir, ["--mode=session-start"], evt, { NTWINE_SCRATCHPAD_HOOK: "maybe" }), "")
  // With no session id there is no key, and an unkeyed pad would bleed across sessions.
  assert.equal(runHook(dir, ["--mode=session-start"], { source: "compact" }, { CLAUDE_CODE_SESSION_ID: "" }), "")
})

test("the codex child epilogue gives a child its OWN file instead of a document to merge into", () => {
  const dir = newProject()
  const out = JSON.parse(
    runHook(dir, [`--session=${SID}`, "--mode=subagent-start"], {
      session_id: "codex-rollout-id",
      agent_id: "/root/reviewer",
      hook_event_name: "SubagentStart",
    })
  )
  assert.equal(out.hookSpecificOutput.hookEventName, "SubagentStart")
  const ctx = out.hookSpecificOutput.additionalContext as string
  assert.match(ctx, new RegExp(`\\.ntwine/threads/${SID}/`))
  assert.match(ctx, /create your own file in it/)
  // The failure this replaced: an undifferentiated "keep the doc current" mandate once made a native
  // child replace a shared document with its task notes, then delete the replacement as a rollback.
  // One file per writer removes the hazard instead of policing it.
  assert.match(ctx, /never edit, replace or delete a file another agent wrote/)
  assert.match(ctx, /nothing to merge and nothing to clobber/)
  assert.doesNotMatch(ctx, /merge your own scoped progress/, "the merge mandate is gone, not reworded")
  // The delegated-authority carve-out survives: a task that says "write only <path>" must not be read
  // as forbidding the child's own coordination file.
  assert.match(ctx, /Ntwine coordination state, not a project deliverable or source edit/)
  assert.match(ctx, /“write only <path>”/)
  assert.match(ctx, /location alone neither permits nor forbids editing/)
})

// SubagentStart is the only structural seam that reaches a native codex child, so it carries the
// codex half of the default-off nesting rule — agent-dispatch.mjs's epilogue is the Claude half.
test("the codex child epilogue tells the child not to spawn agents of its own unasked", () => {
  const dir = newProject()
  const out = JSON.parse(
    runHook(dir, [`--session=${SID}`, "--mode=subagent-start"], {
      session_id: "codex-rollout-id",
      agent_id: "/root/reviewer",
      hook_event_name: "SubagentStart",
    })
  )
  const ctx = out.hookSpecificOutput.additionalContext as string
  assert.match(ctx, /do not spawn agents of your own \(`spawn_agent`\) unless the task you were given explicitly tells you to/)
  assert.match(ctx, /already one prong of the root worker’s fan-out/)
})

test("the nudge tracks context GROWTH, not an absolute threshold or wall clock", () => {
  const dir = newProject()
  const stale = { NTWINE_SCRATCHPAD_STALE_TOKENS: "60000" }
  const nudge = (tokens: number) =>
    runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: writeTranscript(dir, tokens) }, stale)

  // Notes are optional, so a worker that kept none is never nudged, however long the session runs.
  assert.equal(nudge(70_000), "", "an empty directory is never nudged")
  assert.equal(nudge(500_000), "", "not even half a million tokens in")

  writeScratch(dir, "now written with real content\n", "plan.md")
  assert.equal(nudge(510_000), "", "a fresh write starts the clock")
  assert.equal(nudge(550_000), "", "40k of growth is still under the interval")

  const restale = additionalContext(nudge(574_000))
  assert.match(restale, /⟦scratch notes stale⟧/)
  assert.match(restale, /grown ~64k tokens/)
  assert.equal(nudge(580_000), "", "a second nudge must not follow immediately")
})

test("the mid-turn channel reports itself as PostToolUse so the harness accepts the injection", () => {
  const dir = newProject()
  writeScratch(dir, "notes\n", "plan.md")
  runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: writeTranscript(dir, 10_000) }, { NTWINE_SCRATCHPAD_STALE_TOKENS: "60000" })
  const out = runHook(
    dir,
    ["--mode=nudge", "--event=PostToolUse"],
    { session_id: SID, transcript_path: writeTranscript(dir, 90_000) },
    { NTWINE_SCRATCHPAD_STALE_TOKENS: "60000" }
  )
  // An ntwine worker runs enormous autonomous turns; a turn-boundary-only nudge can miss a whole
  // session's work. The event name must match the firing hook or the payload is rejected.
  assert.equal(JSON.parse(out).hookSpecificOutput.hookEventName, "PostToolUse")
  assert.match(additionalContext(out), /⟦scratch notes stale⟧/)
})

test("both nudge channels share one interval, so mid-turn firing does not multiply reminders", () => {
  const dir = newProject()
  const stale = { NTWINE_SCRATCHPAD_STALE_TOKENS: "60000" }
  const t = (tokens: number) => ({ session_id: SID, transcript_path: writeTranscript(dir, tokens) })
  writeScratch(dir, "notes\n", "plan.md")
  assert.equal(runHook(dir, ["--mode=nudge"], t(5_000), stale), "", "the first observation sets the baseline")

  assert.notEqual(runHook(dir, ["--mode=nudge", "--event=PostToolUse"], t(70_000), stale), "", "first fires")
  // The turn-boundary channel must respect the budget the mid-turn channel just spent.
  assert.equal(runHook(dir, ["--mode=nudge"], t(75_000), stale), "", "shared state suppresses the sibling")
  assert.equal(runHook(dir, ["--mode=nudge", "--event=PostToolUse"], t(80_000), stale), "")
})

test("the nudge rebases when ANY file in the directory is touched, by agent or human", () => {
  const dir = newProject()
  const stale = { NTWINE_SCRATCHPAD_STALE_TOKENS: "10000" }
  const nudge = (tokens: number) =>
    runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: writeTranscript(dir, tokens) }, stale)

  writeScratch(dir, "v1 with content\n", "plan.md")
  nudge(20_000)
  assert.notEqual(nudge(40_000), "", "stale after 20k of growth")

  // A DIFFERENT file — the clock is the newest write across the whole directory, not one path's.
  writeScratch(dir, "a sub-agent's findings\n", "reviewer.md")
  const future = new Date(Date.now() + 1000)
  utimesSync(scratchPath(dir, "reviewer.md"), future, future)
  assert.equal(nudge(45_000), "", "any write anywhere in the directory rebases the baseline")
})

test("the nudge is silent when the transcript carries no readable usage", () => {
  const dir = newProject()
  const path = join(dir, "empty.jsonl")
  writeFileSync(path, "not json\n{}\n")
  assert.equal(runHook(dir, ["--mode=nudge"], { session_id: SID, transcript_path: path }), "")
  assert.equal(runHook(dir, ["--mode=nudge"], { session_id: SID }), "")
})

test("hooks.json wires every channel, and no stale carryover registration survives", () => {
  const raw = readFileSync(join(here, "../../../cc-worker/hooks/hooks.json"), "utf8")
  assert.doesNotMatch(raw, /carryover/, "the separate carryover doc was collapsed into the scratchpad")
  const cfg = JSON.parse(raw) as Record<string, Record<string, { matcher?: string; hooks: { command: string }[] }[]>>
  const commandsFor = (event: string) =>
    (cfg.hooks[event] ?? []).flatMap((entry) => entry.hooks.map((h) => h.command))

  for (const matcher of ["startup", "resume", "clear", "compact"]) {
    const entry = (cfg.hooks.SessionStart ?? []).find((e) => e.matcher === matcher)
    assert.ok(entry, `SessionStart must register a ${matcher} matcher`)
    assert.ok(entry.hooks.some((h) => h.command.includes("scratchpad.mjs") && h.command.includes("--mode=session-start")))
  }
  for (const trigger of ["auto", "manual"]) {
    const entry = (cfg.hooks.PreCompact ?? []).find((e) => e.matcher === trigger)
    assert.ok(entry, `PreCompact must register a ${trigger} matcher`)
    assert.ok(entry.hooks.some((h) => h.command.includes("scratchpad.mjs") && h.command.includes("--mode=precompact")))
  }
  assert.ok(commandsFor("UserPromptSubmit").some((c) => c.includes("scratchpad.mjs") && c.includes("--mode=nudge")))
  // The mid-turn channel must be UNMATCHED (every tool), not scoped to one tool name.
  const midTurn = (cfg.hooks.PostToolUse ?? []).find((e) =>
    e.hooks.some((h) => h.command.includes("scratchpad.mjs"))
  )
  assert.ok(midTurn, "PostToolUse must carry the mid-turn nudge")
  assert.equal(midTurn.matcher, undefined, "the mid-turn nudge must fire after every tool call")
  assert.ok(midTurn.hooks.some((h) => h.command.includes("--event=PostToolUse")))
})

// ---- backend parity: the CODEX delivery path ----
// Codex cannot be gated the way Claude is. Measured against codex-cli 0.144.6:
//   • `codex exec` runs NO hooks from any discovery path — only the app-server does, and only when
//     the hooks arrive as per-conversation config overrides (with bypass_hook_trust).
//   • The app-server daemon is SHARED per project, so its environment cannot carry a per-conversation
//     decision — hence `--enabled` rather than the env var.
//   • Codex reports its OWN rollout session id to the hook, not ntwine's thread id — hence `--session`.
// Verified live: SessionStart / UserPromptSubmit / Stop all fired through CodexAppServerBridge with
// the real scratchpad.mjs wired exactly as codexScratchpadHookConfig wires it.

test("re-orienting is UNCONDITIONAL — no setting, no flag, no env var required", () => {
  const dir = newProject()
  writeScratch(dir, "canonical content\n", "plan.md")
  // No opt-in of any kind. An earlier revision gated this behind a default-OFF setting, which meant
  // the DEFAULT worker recovered nothing after a compaction — the exact failure it exists to prevent.
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
  assert.match(ctx, /⟦scratch directory⟧/)
  assert.match(ctx, /plan\.md/)
  // The only escape hatch is an explicit env off — a one-off, not a project posture.
  assert.equal(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }, { NTWINE_SCRATCHPAD_HOOK: "off" }), "")
})

test("an EMPTY directory still re-orients after compaction, and says so plainly", () => {
  const dir = newProject()
  const ctx = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
  // "You lost your context and left yourself nothing" is the most urgent thing the next turn can hear —
  // staying silent here was the old behavior and it left the worker with nothing at all.
  assert.match(ctx, /⟦scratch directory⟧/)
  assert.match(ctx, /is EMPTY — you left yourself nothing to recover from/)
  assert.match(ctx, /Do not search other `\.ntwine\/threads\/\*\/` directories/)
  assert.match(ctx, /retained compaction summary/)
  // …and it says how to not be here again.
  assert.match(ctx, /`ntwinectl goal start --post-compaction`/)
})

test("--session overrides the reported id, so a codex worker finds NTWINE's directory not its own", () => {
  const dir = newProject()
  writeScratch(dir, "ntwine thread content\n", "ntwine-thread-file.md")
  // Exactly what codex sends: its own rollout session id, and a transcript under ~/.codex/sessions.
  const codexEvent = {
    session_id: "019fb427-93aa-7ab0-91af-436173f99bc4",
    source: "compact",
    hook_event_name: "SessionStart",
    transcript_path: "/Users/x/.codex/sessions/2026/07/30/rollout-019fb427.jsonl",
  }
  // Without --session the hook addresses codex's id — a directory that does not exist — so it can
  // only report an empty one.
  const derived = additionalContext(runHook(dir, ["--mode=session-start"], codexEvent))
  assert.doesNotMatch(derived, /ntwine-thread-file\.md/)
  // With it, the real directory is found.
  const explicit = additionalContext(
    runHook(dir, [`--session=${SID}`, "--mode=session-start"], codexEvent)
  )
  assert.match(explicit, /ntwine-thread-file\.md/)
  assert.match(explicit, new RegExp(`\\.ntwine/threads/${SID}/`))
})

// NO FILENAME IS RESERVED, and nothing in a scratch file is parsed. `scratch.md` used to be the one
// canonical name with a `stop_hook:` frontmatter key on top of it; both are gone (2026-08-06). A file
// still called scratch.md is now just another file the worker happened to name that way.
test("no filename is privileged — scratch.md is listed like any other file, and nothing is parsed", () => {
  const dir = newProject()
  writeScratch(dir, "---\nstop_hook: Re-check the operation I still own.\n---\n\nstate\n", "scratch.md")
  writeScratch(dir, "other", "zzz-other.md")
  const out = additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "compact" }))
  assert.match(out, /scratch\.md/)
  assert.match(out, /zzz-other\.md/)
  assert.doesNotMatch(out, /stop_hook/, "frontmatter is not read, because no content is read")
})

test("a codex rollout carries no readable claude usage, so the nudge degrades to silence", () => {
  const dir = newProject()
  writeScratch(dir, "content\n", "plan.md")
  const rollout = join(dir, "rollout.jsonl")
  // The real codex rollout shape — event_msg/payload, not claude's message.usage.
  writeFileSync(
    rollout,
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hi" } }) + "\n"
  )
  // Silence, never a crash and never a bogus token count: the codex nudge channel simply does not
  // fire until a rollout-aware token parser exists. The codex INJECTION channel is unaffected.
  assert.equal(runHook(dir, [`--session=${SID}`, "--mode=nudge"], { session_id: SID, transcript_path: rollout }), "")
})

// ---- codex delivery is unconditional too ----

test("the codex hook config is built unconditionally, and carries what codex requires", () => {
  // No plugin path or no session id must still produce nothing rather than a broken command.
  assert.deepEqual(codexScratchpadHookConfig(undefined, "sid-1"), {})
  assert.deepEqual(codexScratchpadHookConfig("/p/scratchpad.mjs", ""), {})

  const cfg = codexScratchpadHookConfig("/p/scratchpad.mjs", "sid-1") as {
    bypass_hook_trust?: boolean
    hooks?: Record<string, { hooks: { command: string }[] }[]>
  }
  // Codex silently SKIPS untrusted hook definitions, so without this the config is delivered and ignored.
  assert.equal(cfg.bypass_hook_trust, true)
  // Codex exposes no PreCompact/PostCompact wire type, so summarizer steering stays Claude-only.
  // SubagentStart carries the own-file epilogue; the rest orient or nudge.
  assert.deepEqual(Object.keys(cfg.hooks ?? {}).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "SubagentStart", "UserPromptSubmit"])
  for (const [event, entries] of Object.entries(cfg.hooks ?? {})) {
    const cmd = entries[0].hooks[0].command
    if (event === "PreToolUse") {
      assert.match(cmd, /bash-background\.mjs/)
      assert.match(cmd, /--ntwine-thread/)
    } else {
      assert.match(cmd, /--session="sid-1"/, "ntwine's thread id must override codex's own reported session id")
      assert.doesNotMatch(cmd, /--enabled/, "there is no opt-in flag any more")
      assert.match(cmd, /scratchpad\.mjs/)
    }
  }
  assert.match(cfg.hooks?.SubagentStart?.[0]?.hooks[0]?.command ?? "", /--mode=subagent-start/)
  assert.match(cfg.hooks?.SessionStart?.[0]?.hooks[0]?.command ?? "", /--mode=session-start --resume-keeps-context$/)
})

// A Codex thread is resumed from its rollout with its whole conversation, and Ntwine resumes one
// routinely: its first message after every Ntwine restart, and again when a newer Ntwine hands it new
// hooks. Those hooks ride every resume since 2026-10-11, so SessionStart(resume) now FIRES there — and
// "Context was just lost" would be false every time. The Codex registration carries the flag; Claude's
// does not, because a Claude resume is a cold start of the process.
test("a Codex resume is silent, because it lost nothing — and only a resume is", () => {
  const dir = newProject()
  writeScratch(dir, "the approach and why\n", "plan.md")
  const codex = ["--mode=session-start", "--resume-keeps-context"]
  assert.equal(runHook(dir, codex, { session_id: SID, source: "resume" }), "")
  // A compaction did lose the conversation, on Codex as anywhere; a fresh start is still oriented.
  assert.match(additionalContext(runHook(dir, codex, { session_id: SID, source: "compact" })), /Context was just compacted/)
  assert.match(additionalContext(runHook(dir, codex, { session_id: SID, source: "startup" })), /⟦scratch directory⟧/)
  // Without the flag — Claude's registration — a resume keeps its re-orientation.
  assert.match(additionalContext(runHook(dir, ["--mode=session-start"], { session_id: SID, source: "resume" })), /Context was just lost/)
})

// ---- a board that is NOT the worker's cwd: the Home workspace (server/home-workspace.ts) ----
// A Home worker runs in the operator's home folder, but its board lives in Ntwine's state directory:
// `~/.ntwine` is Ntwine's legacy data root, and creating it switches an install onto it at the next boot.
// Ntwine names the board root with NTWINE_BOARD_ROOT (Claude) or `--board-root` (codex's shared
// app-server, which carries no per-thread env). The cwd below gets its OWN `.ntwine/` so that a hook
// ignoring the board root would succeed there — and fail these tests — rather than error out.

const HOME_SID = "11111111-2222-4333-8444-555555555555"

const homeTemps: string[] = []
after(() => {
  for (const dir of homeTemps) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  homeTemps.push(dir)
  return dir
}

function homeBoard(): { cwd: string; board: string } {
  const cwd = temp("scratchpad-home-cwd-")
  mkdirSync(join(cwd, ".ntwine"))
  return { cwd, board: temp("scratchpad-home-board-") }
}

function runHookIn(
  script: string,
  cwd: string,
  args: string[],
  event: Record<string, unknown>,
  env: Record<string, string>,
): string {
  return execFileSync(process.execPath, [join(here, "../../../cc-worker/hooks", script), ...args], {
    cwd,
    input: JSON.stringify(event),
    encoding: "utf8",
    // No `gh` on PATH, so session-seed's auth probe fails fast instead of shelling out.
    env: { ...process.env, PATH: dirname(process.execPath), CLAUDE_PROJECT_DIR: cwd, NTWINE_THREAD: "", NTWINE_SCRATCHPAD_HOOK: "", NTWINE_BOARD_ROOT: "", ...env },
  })
}

for (const [how, args, env] of [
  ["NTWINE_BOARD_ROOT", [] as string[], (board: string) => ({ NTWINE_BOARD_ROOT: board })],
  ["--board-root", ["--board-root=BOARD"], () => ({})],
] as const) {
  test(`scratchpad.mjs: ${how} puts the directory under the board, and names it by its ABSOLUTE path`, () => {
    const { cwd, board } = homeBoard()
    const argv = [...args.map((arg) => arg.replace("BOARD", board)), "--mode=session-start"]
    const ctx = additionalContext(runHookIn("scratchpad.mjs", cwd, argv, { session_id: HOME_SID, source: "startup" }, env(board)))
    const threadDir = join(board, ".ntwine", "threads", HOME_SID)
    assert.ok(existsSync(threadDir), "created under the board root")
    assert.equal(existsSync(join(cwd, ".ntwine", "threads")), false, "never under the worker's cwd")
    // Relative, it would resolve against the cwd — the home folder — which is exactly the wrong place.
    assert.ok(ctx.includes("`" + threadDir + "/`"), ctx)
    assert.doesNotMatch(ctx, /`\.ntwine\/threads\//)
  })
}

test("scratchpad.mjs: the codex child epilogue names the absolute directory too", () => {
  const { cwd, board } = homeBoard()
  const out = runHookIn("scratchpad.mjs", cwd, [`--session=${HOME_SID}`, `--board-root=${board}`, "--mode=subagent-start"], { session_id: "codex-own", agent_id: "child-1" }, {})
  assert.ok(out.includes(join(board, ".ntwine", "threads", HOME_SID) + "/"), out)
  assert.equal(existsSync(join(cwd, ".ntwine", "threads")), false)
})

// The command string is run by a SHELL, so this runs it through one: the JSON-quoted flag has to
// arrive as one argv entry even with a space in the path.
test("the codex hook command carries --board-root, and the hook honors it through a shell", () => {
  const plain = codexScratchpadHookConfig("/p/scratchpad.mjs", "sid-1") as { hooks: Record<string, { hooks: { command: string }[] }[]> }
  for (const entries of Object.values(plain.hooks)) assert.doesNotMatch(entries[0].hooks[0].command, /--board-root/)

  const { cwd } = homeBoard()
  const board = temp("scratchpad home board ")
  const cfg = codexScratchpadHookConfig(HOOK, HOME_SID, board) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
  for (const [event, entries] of Object.entries(cfg.hooks)) {
    const cmd = entries[0].hooks[0].command
    if (event === "PreToolUse") assert.doesNotMatch(cmd, /--board-root/, "the bash guard has no board")
    else assert.ok(cmd.includes(` --board-root=${JSON.stringify(board)} `), cmd)
  }
  const start = cfg.hooks.SessionStart[0].hooks[0].command
  const ctx = additionalContext(
    execSync(start, {
      cwd,
      input: JSON.stringify({ session_id: "019fb427-93aa-7ab0-91af-436173f99bc4", source: "startup" }),
      encoding: "utf8",
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, CLAUDE_PROJECT_DIR: "", NTWINE_THREAD: "", NTWINE_SCRATCHPAD_HOOK: "", NTWINE_BOARD_ROOT: "" },
    }),
  )
  const threadDir = join(board, ".ntwine", "threads", HOME_SID)
  assert.ok(existsSync(threadDir))
  assert.ok(ctx.includes(threadDir + "/"), ctx)
  assert.equal(existsSync(join(cwd, ".ntwine", "threads")), false)
})

test("session-seed.mjs: NTWINE_BOARD_ROOT keeps the sentinel on the board and names the absolute path", () => {
  const { cwd, board } = homeBoard()
  const out = runHookIn("session-seed.mjs", cwd, [], { session_id: HOME_SID, source: "startup" }, { NTWINE_THREAD: "t", NTWINE_BOARD_ROOT: board })
  const ctx = additionalContext(out)
  assert.ok(existsSync(join(board, ".ntwine", ".session-state", HOME_SID)), "the per-session sentinel lands on the board")
  assert.equal(existsSync(join(cwd, ".ntwine", ".session-state")), false)
  assert.ok(ctx.includes("`" + join(board, ".ntwine", "threads", HOME_SID) + "/`"), ctx)
  // …and without it, a registered project's worker is told the relative path exactly as before.
  const plain = additionalContext(runHookIn("session-seed.mjs", cwd, [], { session_id: HOME_SID, source: "startup" }, { NTWINE_THREAD: "t" }))
  assert.ok(plain.includes("`.ntwine/threads/" + HOME_SID + "/`"), plain)
})

test("agent-bind.mjs: NTWINE_BOARD_ROOT records the helper binding on the board, not in the cwd", () => {
  const { cwd, board } = homeBoard()
  mkdirSync(join(board, ".ntwine"))
  const event = {
    session_id: HOME_SID,
    tool_input: { prompt: "THREAD: clone-repo\nDo the thing.", description: "helper" },
    tool_response: { agentId: "agent-1" },
  }
  runHookIn("agent-bind.mjs", cwd, [], event, { NTWINE_THREAD: "t", NTWINE_BOARD_ROOT: board })
  const record = JSON.parse(readFileSync(join(board, ".ntwine", ".agent-bindings.jsonl"), "utf8").trim())
  assert.equal(record.agent_id, "agent-1")
  assert.equal(record.thread, "clone-repo")
  assert.equal(existsSync(join(cwd, ".ntwine", ".agent-bindings.jsonl")), false)
})
