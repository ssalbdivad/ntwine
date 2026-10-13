import { test } from "node:test"
import assert from "node:assert/strict"
import { GithubBatchInput, type CodexModel } from "@ntwine/shared"
import { buildGithubBatchInput, dispatchProfileError } from "./githubDispatch.ts"
import { resolveDispatchPreferences } from "./dispatchPreferences.ts"
import { closeGithubPicker, openGithubPicker, store } from "../store.ts"

const codexModel: CodexModel = {
  slug: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  defaultEffort: "medium",
  efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
}

test("the picker dispatches the LIVE durable profile — the same pair the prompt box resolves", () => {
  const claude = resolveDispatchPreferences(
    { backend: "claude", claude: { model: "opus", effort: "high" }, codex: {} },
    [codexModel],
  )
  assert.deepEqual(
    { backend: claude.backend, model: claude.model, effort: claude.effort },
    { backend: "claude", model: "opus", effort: "high" },
  )

  // Switching the selector in EITHER surface writes one preference row, so the picker's next read is
  // the changed pair — there is no captured copy that can keep dispatching the old one.
  const codex = resolveDispatchPreferences(
    { backend: "codex", claude: { model: "opus", effort: "high" }, codex: { model: codexModel.slug, effort: "ultra" } },
    [codexModel],
  )
  assert.deepEqual(
    { backend: codex.backend, model: codex.model, effort: codex.effort },
    { backend: "codex", model: "gpt-5.6-sol", effort: "ultra" },
  )
  assert.equal(codex.modelAvailable && codex.effortAvailable, true)
})

test("final validation rejects an unavailable model/effort pair without downgrading", () => {
  assert.match(
    dispatchProfileError({ backend: "claude", model: "gpt-5.6-sol", effort: "high" }, [codexModel]) ?? "",
    /no longer available/,
  )
  assert.match(
    dispatchProfileError(
      { backend: "codex", model: codexModel.slug, effort: "ultra", permissionMode: "default" },
      [{ ...codexModel, efforts: ["low", "medium", "high", "xhigh"] }],
    ) ?? "",
    /ultra is not available/,
  )
  assert.equal(dispatchProfileError({ backend: "codex", model: codexModel.slug, effort: "ultra" }, [codexModel]), undefined)
})

test("multi-select builds one exact RPC payload with the live tuple for every item", () => {
  const profile = { backend: "codex", model: codexModel.slug, effort: "ultra" } as const
  const input = buildGithubBatchInput(profile, [
    { kind: "issue", number: 17 },
    { kind: "issue", number: 23 },
  ])
  assert.deepEqual(input, {
    items: [{ kind: "issue", number: 17 }, { kind: "issue", number: 23 }],
    backend: "codex",
    model: "gpt-5.6-sol",
    effort: "ultra",
  })
  assert.deepEqual(GithubBatchInput.parse(input), input)
  assert.throws(() => GithubBatchInput.parse({ ...input, backend: undefined }), /backend/)
  assert.throws(() => GithubBatchInput.parse({ ...input, extraDefault: "opus" }), /unrecognized/i)
})

test("opening the picker carries no profile state — the modal reads the live preference itself", () => {
  try {
    openGithubPicker()
    assert.equal(store.showGithubPicker, true)
    assert.equal("githubDispatchProfile" in store, false)

    closeGithubPicker()
    assert.equal(store.showGithubPicker, false)
  } finally {
    closeGithubPicker()
  }
})

test("an acp profile is judged on its AGENT: a model inside an installed agent dispatches, one inside a missing agent does not", () => {
  const agents = [
    { id: "opencode", label: "OpenCode", command: "opencode", args: ["acp"], available: true },
    { id: "cursor", label: "Cursor", command: "cursor-agent", args: ["acp"], available: false },
  ]
  assert.equal(dispatchProfileError({ backend: "acp", model: "acp:opencode@openai/gpt-5.5" }, [codexModel], agents), undefined)
  assert.equal(dispatchProfileError({ backend: "acp", model: "acp:opencode" }, [codexModel], agents), undefined)
  assert.match(dispatchProfileError({ backend: "acp", model: "acp:cursor@gpt-5.5" }, [codexModel], agents) ?? "", /not installed/)
  assert.match(dispatchProfileError({ backend: "acp", model: "acp:nope" }, [codexModel], agents) ?? "", /not in the catalogue/)
})
