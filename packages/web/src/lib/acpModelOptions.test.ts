import { test } from "node:test"
import assert from "node:assert/strict"
import type { AcpAgentModels } from "@ntwine/shared"
import { acpModelGroups } from "./acpModelOptions.ts"

const advertised: AcpAgentModels = {
  agentId: "opencode",
  models: [
    { id: "openai/gpt-5.5", name: "OpenAI/GPT-5.5" },
    { id: "xai/grok-4.6", name: "xAI/Grok 4.6" },
    { id: "openai/gpt-5.4", name: "OpenAI/GPT-5.4" },
    { id: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle" },
    { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
    { id: "local-llm", name: "Local" },
  ],
  current: "opencode/big-pickle",
  probedAt: "2026-09-16T00:00:00.000Z",
}

test("models group by the provider prefix of their name, in order of first appearance, after an unheaded Default row", () => {
  const groups = acpModelGroups(advertised, undefined)
  assert.deepEqual(groups.map((group) => [group.label, group.options.map((row) => [row.value, row.label])]), [
    ["", [["", "Default · Big Pickle"]]],
    ["OpenAI", [["openai/gpt-5.5", "GPT-5.5"], ["openai/gpt-5.4", "GPT-5.4"]]],
    ["xAI", [["xai/grok-4.6", "Grok 4.6"]]],
    ["OpenCode Zen", [["opencode/big-pickle", "Big Pickle"]]],
    // No slash in the name: the id's prefix names the provider; neither: a generic section.
    ["anthropic", [["anthropic/claude-opus-5", "Claude Opus 5"]]],
    ["Models", [["local-llm", "Local"]]],
  ])
})

test("a saved model the agent no longer lists stays visible in the lead section and reads unavailable; while unknown it is shown verbatim", () => {
  assert.deepEqual(acpModelGroups(advertised, "openai/gpt-4o")[0]!.options.map((row) => row.label), ["Default · Big Pickle", "openai/gpt-4o (unavailable)"])
  assert.deepEqual(acpModelGroups(undefined, "openai/gpt-4o").map((group) => group.options.map((row) => row.label)), [["Default", "openai/gpt-4o"]])
  const failed: AcpAgentModels = { agentId: "cursor", models: [], error: "not logged in", probedAt: advertised.probedAt }
  assert.deepEqual(acpModelGroups(failed, "gpt-5.5").map((group) => group.options.map((row) => row.label)), [["Default", "gpt-5.5"]])
  // A saved model that IS advertised is not duplicated into the lead section.
  const rows = acpModelGroups(advertised, "openai/gpt-5.5").flatMap((group) => group.options)
  assert.equal(rows.filter((row) => row.value === "openai/gpt-5.5").length, 1)
})
