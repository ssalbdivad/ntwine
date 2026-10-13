// LEGACY (legacy-frizz.ts; deleted with it). SERVER-SIDE MARKERS WRITTEN BEFORE THE RENAME. Each case
// builds today's text with its real writer, respells it as pre-rename code wrote it (frizzWording), and
// asserts the reader treats the two alike. The shared recognizers have their own copy of this check
// (shared/src/legacy-frizz.test.ts).
import assert from "node:assert/strict"
import { test } from "node:test"
import { frizzWording } from "@ntwine/shared"
import { extractCodexNtwineTitle } from "./backend/codex.ts"
import { relayedTaskIds, relayMessage, relayNotificationBlock, type QueuedReport } from "./completion-relay.ts"
import { renderGithubPrompt } from "./github.ts"
import { dispatchProfileCell } from "./subagent-profile.ts"
import { githubDispatchDisplayText } from "./transcript.ts"

function respelled(text: string): string {
  const old = frizzWording(text)
  assert.notEqual(old, text, "the case must carry the product's name")
  return old
}

// The relay's marker is its ONLY idempotence evidence: a repair injected before the rename that no longer
// reads as one is repaired again on the next fold.
test("a completion relayed before the rename still resolves its task and still renders as the relay", () => {
  const report: QueuedReport = { taskId: "a26ab44059b4cf3db", kind: "agent", chars: 14796, outputFile: "/t/a.output", summary: 'Agent "Impact analysis" finished' }
  const msg = relayMessage(report)
  const old = respelled(msg)
  assert.deepEqual(relayedTaskIds(old), ["a26ab44059b4cf3db"])
  assert.equal(relayNotificationBlock(old), relayNotificationBlock(msg))
})

test("a Codex title comment written before the rename still names the thread", () => {
  const text = '<!-- ntwine title="Fix queue focus" -->\nVisible answer'
  assert.deepEqual(extractCodexNtwineTitle(respelled(text)), extractCodexNtwineTitle(text))
})

test("a GitHub dispatch written before the rename still shows only its lead", () => {
  const prompt = renderGithubPrompt("Look at {url}", "cli/cli", { number: 326, title: "Flaky test", url: "https://github.com/cli/cli/issues/326", labels: [], body: "" }, "investigate-cli-cli-326", "issue")
  const shown = githubDispatchDisplayText(prompt)
  assert.ok(shown)
  assert.equal(githubDispatchDisplayText(respelled(prompt)), shown)
})

test("a sub-agent dispatched under the frizz: plugin namespace reads as an ntwine profile", () => {
  const turn = { turnModel: "claude-opus-5", turnEffort: "xhigh" }
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high", model: "opus", ...turn }), "ntwine:opus-high")
  assert.equal(dispatchProfileCell({ subagentType: "frizz:frizz-opus-high", ...turn }), "ntwine:opus-high")
})
