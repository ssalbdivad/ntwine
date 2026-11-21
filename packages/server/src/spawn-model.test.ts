import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnModelFor } from "./spawn-model.ts"

test("a Gemini name on the default backend is refused with the slug it meant", () => {
  // The case that started a Claude thread on model "neon" (2026-11-20).
  assert.throws(() => spawnModelFor("neon", undefined), /`neon` is not a model ntwine can start\. Did you mean `acp:antigravity@gemini-4-neon`\?/)
  assert.throws(() => spawnModelFor("gemini-4-neon", "claude"), /Did you mean `acp:antigravity@gemini-4-neon`\?/)
})

test("an ACP slug carries its backend, and refuses another", () => {
  assert.deepEqual(spawnModelFor("acp:antigravity@gemini-4-neon", undefined), { model: "acp:antigravity@gemini-4-neon", backend: "acp" })
  assert.deepEqual(spawnModelFor("acp:antigravity", "acp"), { model: "acp:antigravity", backend: "acp" })
  assert.throws(() => spawnModelFor("acp:antigravity@gemini-4-neon", "claude"), /backend is `acp`, not `claude`/)
  assert.throws(() => spawnModelFor("acp:", undefined), /names no agent/)
})

test("Claude aliases and wire ids run on Claude; a gpt id infers Codex", () => {
  assert.deepEqual(spawnModelFor("opus", undefined), { model: "opus", backend: "claude" })
  assert.deepEqual(spawnModelFor("sonnet[1m]", "claude"), { model: "sonnet[1m]", backend: "claude" })
  assert.deepEqual(spawnModelFor("claude-opus-5-5", undefined), { model: "claude-opus-5-5", backend: "claude" })
  assert.deepEqual(spawnModelFor("gpt-6-sol", undefined), { model: "gpt-6-sol", backend: "codex" })
  assert.throws(() => spawnModelFor("opus", "codex"), /is a Claude model, not a Codex one/)
})

test("an unknown word is refused with every family's names", () => {
  assert.throws(() => spawnModelFor("gpt-6-sol", "claude"), /`gpt-6-sol` is not a Claude model\. Claude: `fable`, `opus`, `sonnet`, `haiku`\./)
  assert.throws(() => spawnModelFor("turbo", undefined), /not a Claude model.*acp:antigravity@gemini-4-neon/)
})
