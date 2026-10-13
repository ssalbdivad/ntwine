import test from "node:test"
import assert from "node:assert/strict"
import { isNoisePrActivity } from "./pr-watch-noise.ts"

const bot = (actor: string, body?: string) => ({ actor, actorType: "Bot", body })

test("noise: a human item is never muted, whatever it says", () => {
  assert.equal(isNoisePrActivity({ actor: "dana", actorType: "User", body: "[vc]: #deploy-table" }), false)
  assert.equal(isNoisePrActivity({ actor: "vercel", actorType: "User", body: "" }), false, "the actor list only applies to a Bot actor")
})

test("noise: a tier-1 actor is muted outright, in GraphQL and REST login forms alike", () => {
  assert.equal(isNoisePrActivity(bot("vercel", "anything at all")), true)
  assert.equal(isNoisePrActivity(bot("changeset-bot")), true)
  // REST spells the login with a [bot] suffix; the GraphQL-form list must still match it.
  assert.equal(isNoisePrActivity({ actor: "linear-code[bot]", body: "linked ENG-123" }), true)
})

test("noise: an empty review body is NEVER muted — the substance is inline comments", () => {
  assert.equal(isNoisePrActivity(bot("pullfrog", "")), false)
  assert.equal(isNoisePrActivity(bot("cursor-com")), false)
})

test("noise: a tier-2 marker mutes at the START of the body only", () => {
  assert.equal(isNoisePrActivity(bot("coderabbitai", "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n## Walkthrough")), true)
  assert.equal(isNoisePrActivity(bot("pullfrog", "New pull request. Leaping into action...")), true)
  // A substantive review that merely CONTAINS a marker-ish string stays live.
  assert.equal(isNoisePrActivity(bot("coderabbitai", "Found a bug in `foo.ts`.\n\n<!-- This is an auto-generated comment: summarize by coderabbit.ai -->")), false)
})

test("noise: a tier-3 lead mutes through HTML-comment and blockquote chrome, never as a substring", () => {
  assert.equal(isNoisePrActivity(bot("chatgpt-codex-connector", "<!-- meta -->\n> Codex Review: Didn't find any major issues. Nice work!")), true)
  assert.equal(isNoisePrActivity(bot("copilot-pull-request-reviewer", "Copilot was unable to review this pull request because of a quota limit.")), true)
  // "rate limit" mid-body is exactly the false positive the anchoring exists for (72 CodeRabbit hits).
  assert.equal(isNoisePrActivity(bot("coderabbitai", "The retry loop ignores the rate limit header — that is a bug.")), false)
})

test("noise: Pullfrog's own clean-bill re-review stays LIVE — a deliberate keep, not a gap", () => {
  assert.equal(isNoisePrActivity(bot("pullfrog", "✅ No new issues found.")), false)
})
