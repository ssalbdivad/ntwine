import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const names = ["ci-watch.mjs", "github-watch.mjs", "review-watch.mjs"]
const targets = ["cc-worker/skills/gh/scripts"]

test("provider packages contain byte-identical generated monitor entrypoints", () => {
  for (const target of targets) for (const name of names) {
    const source = join(root, "monitors", name)
    const copy = join(root, target, name)
    assert.ok(existsSync(copy), `missing ${copy}`)
    assert.equal(readFileSync(copy, "utf8"), readFileSync(source, "utf8"), `${copy} drifted from ${source}`)
  }
})

test("portable monitor guidance requires declared-project precedence and explicit validation", () => {
  const guide = readFileSync(join(root, "monitors", "README.md"), "utf8")
  assert.match(guide, /inspect project-local `AGENTS\.md`, active skills, repository docs,[\s\S]*`package\.json` scripts, and declared monitor tooling/)
  assert.match(guide, /Validate its absolute command and its\s+terminal event\/exit contract before launching it/)
  assert.match(guide, /do not silently fall back[\s\S]*shadow it/)
})

// The codex ORCHESTRATOR skill is retired, but Codex is still a live ntwine worker BACKEND, so its
// golden worker prompt keeps the declared-tooling prescription in the contract itself.
//
// THE TWO BACKENDS CARRY IT IN DIFFERENT PLACES, and asserting otherwise is what broke this test.
// `c4e6b767` condensed the Claude contract and, as its body says, took "the project-declared-monitor
// prescription and the ntwine:waits pointer" out of it — the `waits` skill had been deleted in
// `0b2fd7ed`, and the guidance still reaches a Claude worker through the `gh` skill asserted below,
// which is loaded on demand rather than paid for on every turn. The goldens are current, not stale:
// dispatch.test.ts compares both byte-for-byte against their sources and is green. So the Claude
// contract is pinned on the rules it DOES still carry; do not "restore" the codex wording to it.
test("worker guidance prefers declared tooling and makes no Luna child mandatory", () => {
  const claude = readFileSync(join(root, "cc-worker/skills/gh/SKILL.md"), "utf8")
  assert.match(claude, /project-local `AGENTS\.md`/)
  assert.match(claude, /terminal\s+event\/exit contract/)
  assert.match(claude, /never silently shadow/)
  assert.match(claude, /workflow name.*event|workflow name plus event/)
  assert.match(claude, /use native `Monitor`/)

  const promptDir = join(root, "packages/server/src")
  const codexPrompt = readFileSync(join(promptDir, "WORKER_PROMPT.codex.golden.txt"), "utf8")
  const claudePrompt = readFileSync(join(promptDir, "WORKER_PROMPT.claude.golden.txt"), "utf8")

  assert.match(codexPrompt, /project-local `AGENTS\.md`/)
  assert.match(codexPrompt, /terminal event\/exit semantics/)
  assert.match(codexPrompt, /silently shadow/)
  assert.match(codexPrompt, /Luna child is optional/)
  assert.doesNotMatch(codexPrompt, /cheap monitor child/)

  // What the Claude contract still says about waiting, so condensing it again cannot silently empty
  // the section: which mechanism to reach for, who owns a wait you REST on, and no faked waits.
  assert.match(claudePrompt, /The mechanism is decided by whether you will REST while it runs/)
  assert.match(claudePrompt, /dispatch a sub-agent to own the wait/)
  assert.match(claudePrompt, /Never fake a wait with `echo waiting`/)
})
