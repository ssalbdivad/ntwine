import { test } from "node:test"
import assert from "node:assert/strict"
import { acpAgentIdFromModel, acpModelIdFromModel, acpModelPreset, acpModelSlug, type CodexModel, type DispatchPreferences } from "@frizz/shared"
import {
  applyDispatchPreferenceUpdate,
  dispatchModelGroups,
  dispatchProfileGroups,
  parseDispatchPick,
  pickFromSelection,
  resolveDispatchPreferences,
  withDispatchPick,
} from "./dispatchPreferences.ts"

const models: CodexModel[] = [
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high", "ultra"] },
  { slug: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
]

const preferences: DispatchPreferences = {
  backend: "claude",
  claude: { model: "sonnet", effort: "max", permissionMode: "acceptEdits" },
  codex: { model: "gpt-5.5", effort: "xhigh", permissionMode: "plan" },
}

test("provider switching restores each runtime's exact model and effort profile", () => {
  assert.deepEqual(resolveDispatchPreferences(preferences, models), {
    backend: "claude",
    model: "sonnet",
    pickerModel: "sonnet",
    effort: "max",
    codexModel: undefined,
    modelAvailable: true,
    effortAvailable: true,
    effortOptions: [
      { value: "auto", label: "Auto" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "X-high" },
      { value: "max", label: "Max" },
      // Sonnet is xhigh-capable, so it carries the ultracode rung (xhigh + workflow orchestration).
      { value: "ultracode", label: "Ultracode" },
    ],
  })
  const codex = applyDispatchPreferenceUpdate(preferences, { field: "backend", value: "codex" })
  const resolved = resolveDispatchPreferences(codex, models)
  assert.equal(resolved.model, "gpt-5.5")
  assert.equal(resolved.effort, "xhigh")
  assert.deepEqual(codex.claude, preferences.claude, "switching provider leaves Claude intent untouched")
})

test("choosing a model switches runtime atomically without replacing the other runtime profile", () => {
  const next = applyDispatchPreferenceUpdate(preferences, { field: "model", backend: "codex", value: "gpt-5.6-sol" })
  assert.equal(next.backend, "codex")
  assert.equal(next.codex.model, "gpt-5.6-sol")
  assert.deepEqual(next.claude, preferences.claude)
})

test("choosing a matrix cell writes one complete provider profile atomically", () => {
  const next = applyDispatchPreferenceUpdate(preferences, {
    field: "profile",
    backend: "codex",
    model: "gpt-5.6-sol",
    effort: "ultra",
  })
  assert.equal(next.backend, "codex")
  assert.deepEqual(next.codex, { ...preferences.codex, model: "gpt-5.6-sol", effort: "ultra" })
  assert.deepEqual(next.claude, preferences.claude)
})

test("dispatch profile groups keep provider catalogues and per-model effort sets scoped", () => {
  const groups = dispatchProfileGroups(models)
  assert.deepEqual(groups.map((group) => group.id), ["claude", "codex"])
  assert.deepEqual(
    groups[0]?.options.find((option) => option.model === "opus")?.efforts,
    ["auto", "low", "medium", "high", "xhigh", "max", "ultracode"],
    "the Claude ladder tops out at ultracode — and must never offer Codex-only ultra",
  )
  // Ultracode needs an xhigh-capable model; Claude ignores the setting on Haiku rather than failing,
  // so that row must not offer a rung that would quietly do nothing.
  assert.deepEqual(
    groups[0]?.options.find((option) => option.model === "haiku")?.efforts,
    ["auto", "low", "medium", "high", "xhigh", "max"],
    "Haiku cannot honour ultracode, so its row stops at max",
  )
  for (const option of groups[0]?.options ?? []) {
    assert.equal(option.efforts.includes("ultra"), false, "the Claude selector must not offer Codex-only ultra")
  }
  assert.deepEqual(groups[1]?.options[0], {
    model: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    defaultEffort: "auto",
    efforts: ["auto", "low", "medium", "high", "ultra"],
  })
  assert.equal(groups[1]?.options.some((option) => option.model === "opus"), false)
})

test("a profile with no saved effort defaults to auto on both runtimes", () => {
  const bare: DispatchPreferences = { ...preferences, claude: { ...preferences.claude, effort: undefined } }
  assert.equal(resolveDispatchPreferences(bare, models).effort, "auto")
  assert.equal(resolveDispatchPreferences(bare, models).effortAvailable, true)
  const codex: DispatchPreferences = { ...preferences, backend: "codex", codex: { ...preferences.codex, effort: undefined } }
  assert.equal(resolveDispatchPreferences(codex, models).effort, "auto")
})

test("a renamed/unavailable saved model remains visible and invalid instead of becoming Opus or a catalogue default", () => {
  const saved: DispatchPreferences = {
    ...preferences,
    backend: "codex",
    codex: { model: "gpt-renamed", effort: "ultra", permissionMode: "bypassPermissions" },
  }
  const resolved = resolveDispatchPreferences(saved, models)
  assert.equal(resolved.model, "gpt-renamed")
  assert.equal(resolved.effort, "ultra")
  assert.equal(resolved.modelAvailable, false)
  assert.equal(resolved.effortAvailable, false)
  assert.equal(dispatchModelGroups(models, "codex", "gpt-renamed")[0]?.options[0]?.value, "gpt-renamed")
  assert.deepEqual(saved.codex, { model: "gpt-renamed", effort: "ultra", permissionMode: "bypassPermissions" }, "resolution is read-only")
})

test("an incompatible saved effort is surfaced for explicit correction rather than silently clamped", () => {
  const saved: DispatchPreferences = {
    ...preferences,
    backend: "codex",
    codex: { model: "gpt-5.5", effort: "ultra", permissionMode: "default" },
  }
  const resolved = resolveDispatchPreferences(saved, models)
  assert.equal(resolved.modelAvailable, true)
  assert.equal(resolved.effort, "ultra")
  assert.equal(resolved.effortAvailable, false)
  assert.equal(resolved.effortOptions[0]?.value, "ultra")
})

test("the acp model slug carries an optional agent model after @, and model ids may contain / and :", () => {
  assert.equal(acpModelSlug("opencode"), "acp:opencode")
  assert.equal(acpModelSlug("opencode", "openai/gpt-5.5"), "acp:opencode@openai/gpt-5.5")
  assert.equal(acpAgentIdFromModel("acp:opencode@openai/gpt-5.5"), "opencode")
  assert.equal(acpModelIdFromModel("acp:opencode@openai/gpt-5.5"), "openai/gpt-5.5")
  assert.equal(acpModelIdFromModel("acp:opencode"), undefined)
  assert.equal(acpAgentIdFromModel("acp:"), undefined)
  assert.equal(acpAgentIdFromModel("opus"), undefined)
  assert.equal(acpModelIdFromModel("acp:grok@grok-4.6:fast"), "grok-4.6:fast")
})

test("an acp profile naming a model resolves the agent for the grid and the model for the dropdown", () => {
  const agents = [{ id: "opencode", label: "OpenCode", command: "opencode", args: ["acp"], available: true }]
  const resolved = resolveDispatchPreferences({ ...preferences, backend: "acp", acp: { model: "acp:opencode@openai/gpt-5.5" } }, models, agents)
  assert.equal(resolved.model, "acp:opencode@openai/gpt-5.5")
  assert.equal(resolved.pickerModel, "acp:opencode")
  assert.equal(resolved.acpAgentId, "opencode")
  assert.equal(resolved.acpModelId, "openai/gpt-5.5")
  assert.equal(resolved.modelAvailable, true)
  assert.equal(resolved.effort, "")
  // The bare agent slug (the agent's own default model) has no model id, and a non-acp profile carries neither.
  const bare = resolveDispatchPreferences({ ...preferences, backend: "acp", acp: { model: "acp:opencode" } }, models, agents)
  assert.equal(bare.pickerModel, "acp:opencode")
  assert.equal(bare.acpModelId, undefined)
  assert.equal(resolveDispatchPreferences(preferences, models, agents).pickerModel, "sonnet")
  // Availability is the AGENT's: a model inside an uninstalled agent is unavailable, a model inside an installed one is not judged here.
  const missing = resolveDispatchPreferences({ ...preferences, backend: "acp", acp: { model: "acp:cursor@gpt-5.5" } }, models, agents)
  assert.equal(missing.modelAvailable, false)
  assert.equal(missing.pickerModel, "acp:cursor")
})

// A preset (Muse Wonder) is its own row with an effort ladder: the grid is keyed on its full slug, its
// effort is kept and judged against the ladder, and no agent-model dropdown stands beside it.
test("an acp preset resolves as a model with efforts, and lists only under an installed agent", () => {
  const agents = [{ id: "opencode", label: "OpenCode", command: "opencode", args: ["acp"], available: true }]
  const muse = "acp:opencode@openrouter/meta/muse-wonder"
  assert.deepEqual(acpModelPreset(muse)?.label, "Muse Wonder")
  assert.equal(acpModelPreset("acp:kilo@openrouter/meta/muse-wonder"), undefined, "the same model through another agent is no preset")
  assert.equal(acpModelPreset("acp:opencode"), undefined)
  const saved = resolveDispatchPreferences({ ...preferences, backend: "acp", acp: { model: muse, effort: "high" } }, models, agents)
  assert.deepEqual(
    [saved.pickerModel, saved.effort, saved.effortAvailable, saved.acpAgentId, saved.acpModelId, saved.modelAvailable],
    [muse, "high", true, undefined, undefined, true],
  )
  assert.equal(resolveDispatchPreferences({ ...preferences, backend: "acp", acp: { model: muse } }, models, agents).effort, "medium", "no saved effort: the preset's default")
  assert.equal(resolveDispatchPreferences({ ...preferences, backend: "acp", acp: { model: muse, effort: "ultra" } }, models, agents).effortAvailable, false)
  const acp = (installed: boolean) => dispatchProfileGroups(models, [{ ...agents[0]!, available: installed }]).find((group) => group.id === "acp")
  assert.deepEqual(acp(true)?.options.map((option) => [option.label, option.efforts.join(" ")]), [
    ["OpenCode", ""],
    ["Muse Wonder", "low medium high xhigh max"],
    ["Muse Wonder Full", "low medium high xhigh max"],
  ])
  assert.equal(acp(false), undefined)
})

// The Claude rows read the EDITION the pinned runtime resolves each alias to ("Opus 5.5") — the same
// treatment the Codex rows get from the codex cache — while the VALUE stays the alias the profile is
// keyed on. An alias the runtime list does not name keeps its family word, which is also the whole
// loading / older-server state.
test("the Claude rows take their edition labels from the runtime-resolved catalogue, keyed on the alias", () => {
  const claudeModels = [
    { alias: "fable", label: "Fable 5.1", resolvedModel: "claude-fable-5-1" },
    { alias: "opus", label: "Opus 5.5", resolvedModel: "claude-opus-5-5" },
    { alias: "sonnet", label: "Sonnet 5", resolvedModel: "claude-sonnet-5" },
  ]
  const claude = dispatchProfileGroups(models, [], claudeModels).find((group) => group.id === "claude")!
  assert.deepEqual(claude.options.map((option) => [option.model, option.label]), [
    ["fable", "Fable 5.1"],
    ["opus", "Opus 5.5"],
    ["sonnet", "Sonnet 5"],
    ["haiku", "Haiku"],
  ])
  // Without the list (loading, an older server) every row keeps its family word.
  assert.deepEqual(
    dispatchProfileGroups(models).find((group) => group.id === "claude")!.options.map((option) => option.label),
    ["Fable", "Opus", "Sonnet", "Haiku"],
  )
  // The dropdown form overlays the same labels, and a saved alias still resolves as available.
  const groups = dispatchModelGroups(models, "claude", "opus", claudeModels)
  assert.equal(groups[0]!.label, "Claude Code")
  assert.equal(groups[0]!.options.find((option) => option.value === "opus")?.label, "Opus 5.5")
  assert.equal(resolveDispatchPreferences({ ...preferences, claude: { model: "opus", effort: "high", permissionMode: "acceptEdits" } }, models).modelAvailable, true)
})

// A pick is a dispatch surface's choice for the thread it starts NEXT, laid over the durable default
// without writing it (useDispatchProfile). Choosing the default's own cell drops the pick, so a stale
// copy of the default can never outlive a later change to it.
test("a pick rides over the default without touching it, and landing back on the default drops it", () => {
  const defaults: DispatchPreferences = { ...preferences, claude: { model: "opus", effort: "medium", permissionMode: "auto" } }
  const defaultResolved = resolveDispatchPreferences(defaults, models)
  const pick = pickFromSelection({ backend: "claude", model: "opus", effort: "max" }, defaultResolved)
  assert.deepEqual(pick, { backend: "claude", model: "opus", effort: "max" })
  assert.equal(resolveDispatchPreferences(withDispatchPick(defaults, pick), models).effort, "max")
  assert.equal(defaults.claude.effort, "medium", "laying a pick over the default never mutates it")
  assert.deepEqual(withDispatchPick(defaults, undefined), defaults)
  // The other runtime's profile survives a pick on this one, exactly as a default write leaves it.
  assert.deepEqual(withDispatchPick(defaults, { backend: "codex", model: "gpt-5.6-sol", effort: "ultra" }).claude, defaults.claude)

  assert.equal(pickFromSelection({ backend: "claude", model: "opus", effort: "medium" }, defaultResolved), undefined)
  // An ACP agent has no effort axis: the grid hands over "", which is no effort, not an empty one.
  assert.deepEqual(pickFromSelection({ backend: "acp", model: "acp:opencode", effort: "" }, defaultResolved), { backend: "acp", model: "acp:opencode" })
})

// The prompt box keeps its pick beside its draft in sessionStorage, so what comes back is untrusted
// text: anything that is not a whole, valid profile reads as no pick, never as a partial one.
test("a stored pick parses back whole or not at all", () => {
  assert.deepEqual(parseDispatchPick(JSON.stringify({ backend: "codex", model: "gpt-5.5", effort: "xhigh" })), { backend: "codex", model: "gpt-5.5", effort: "xhigh" })
  assert.deepEqual(parseDispatchPick(JSON.stringify({ backend: "acp", model: "acp:opencode@gpt-5.5" })), { backend: "acp", model: "acp:opencode@gpt-5.5" })
  for (const raw of [
    "",
    "{",
    "null",
    "5",
    JSON.stringify({ backend: "claude", model: "opus" }),
    JSON.stringify({ backend: "claude", model: "opus", effort: "turbo" }),
    JSON.stringify({ backend: "gemini", model: "x", effort: "low" }),
  ]) {
    assert.equal(parseDispatchPick(raw), undefined, raw)
  }
})
