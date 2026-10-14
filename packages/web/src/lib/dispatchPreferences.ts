import {
  ACP_MODEL_PRESETS,
  acpAgentIdFromModel,
  acpModelIdFromModel,
  acpModelPreset,
  acpModelSlug,
  SetDispatchPreferenceInput,
  type AcpAgent,
  type Backend,
  type ClaudeModel,
  type CodexModel,
  type DispatchPreferences,
} from "@ntwine/shared"
import type { SelectGroup, SelectOption } from "../components/ui/Select.tsx"
import type { ProfileGridGroup, ProfileGridOption } from "./profileGrid.ts"
import {
  AUTO_EFFORT,
  CLAUDE_MODELS,
  claudeModelOptions,
  claudeEfforts,
  claudeEffortOptions,
  codexEffortOptions,
  modelGroups,
} from "./options.ts"

export interface ResolvedDispatchPreferences {
  backend: Backend
  // The slug dispatch sends: a Claude alias, a Codex slug, or `acp:<agent>[@<model>]`.
  model: string
  // The model the profile GRID is keyed on. An ACP row is one row per AGENT (`acp:<agent>`), and the
  // agent's model lives in the dropdown beside the pill — so the grid must never see the `@<model>`
  // tail, or a saved model would read as "unknown profile" the moment one was chosen.
  pickerModel: string
  effort: string
  codexModel?: CodexModel
  // ACP only: the agent id and the model chosen inside it (undefined = the agent's own default). Both
  // absent on a preset, whose model is its row: no dropdown of the agent's models stands beside it.
  acpAgentId?: string
  acpModelId?: string
  modelAvailable: boolean
  effortAvailable: boolean
  effortOptions: SelectOption[]
}

// A choice made in a dispatch surface's picker — the prompt box, the GitHub batch picker — for the
// thread (or batch) that surface starts NEXT. It rides over the durable default without writing it:
// before 2026-09-28 every pick WAS the default, so escalating one hard task to max left every later
// thread on max until someone noticed (maintainer: "i find myself often wanting to default to medium
// but at some point i change to max and it stays there"). Only "Make default" writes the record now.
export type DispatchPick = Omit<Extract<SetDispatchPreferenceInput, { field: "profile" }>, "field">

/** The record a surface dispatches from: the default with its pick, if any, laid over it. */
export function withDispatchPick(preferences: DispatchPreferences, pick: DispatchPick | undefined): DispatchPreferences {
  return pick ? applyDispatchPreferenceUpdate(preferences, { field: "profile", ...pick }) : preferences
}

/** A pick read back from session storage (drafts.ts). Anything malformed reads as no pick — the
 *  surface falls back to the default rather than throwing or dispatching a half-parsed profile. */
export function parseDispatchPick(raw: string): DispatchPick | undefined {
  if (!raw) return undefined
  try {
    const parsed = SetDispatchPreferenceInput.safeParse({ ...JSON.parse(raw), field: "profile" })
    if (!parsed.success || parsed.data.field !== "profile") return undefined
    const { backend, model, effort } = parsed.data
    return { backend, model, ...(effort ? { effort } : {}) }
  } catch {
    return undefined
  }
}

type ProfileIdentity = Pick<ResolvedDispatchPreferences, "backend" | "model" | "effort">

/** Whether two profiles start the same thread. `effort` is "" on both sides for an ACP agent. */
export function sameDispatchProfile(a: ProfileIdentity, b: ProfileIdentity): boolean {
  return a.backend === b.backend && a.model === b.model && a.effort === b.effort
}

/**
 * A picker selection as the surface's new pick — or undefined when it lands back ON the default, so
 * choosing the default's own cell drops the pick instead of storing a copy of the default that would
 * outlive a later change to it.
 */
export function pickFromSelection(
  selection: { backend: Backend; model: string; effort?: string },
  defaultProfile: ProfileIdentity | undefined,
): DispatchPick | undefined {
  const effort = (selection.effort || undefined) as DispatchPick["effort"]
  if (defaultProfile && sameDispatchProfile({ backend: selection.backend, model: selection.model, effort: effort ?? "" }, defaultProfile)) return undefined
  return { backend: selection.backend, model: selection.model, ...(effort ? { effort } : {}) }
}

export function applyDispatchPreferenceUpdate(
  current: DispatchPreferences,
  update: SetDispatchPreferenceInput,
): DispatchPreferences {
  if (update.field === "backend") return { ...current, backend: update.value }
  if (update.field === "profile") {
    return {
      ...current,
      backend: update.backend,
      [update.backend]: {
        ...current[update.backend],
        model: update.model,
        effort: update.effort,
      },
    }
  }
  return {
    ...current,
    ...(update.field === "model" ? { backend: update.backend } : {}),
    [update.backend]: { ...current[update.backend], [update.field]: update.value },
  }
}

// `claudeModels` is the runtime-resolved Claude catalogue (the claudeModels RPC): the Claude rows take
// their edition labels from it ("Opus 5.5"), exactly as the Codex rows take theirs from the codex cache.
export function dispatchProfileGroups(codexModels: readonly CodexModel[], acpAgents: readonly AcpAgent[] = [], claudeModels: readonly ClaudeModel[] = []): ProfileGridGroup[] {
  // Only the agents actually on the server's PATH get a row: the catalogue lists eight, and a grid of
  // "not installed" rows would bury the two the operator has. A SAVED agent that has since gone
  // missing surfaces through resolveDispatchPreferences's `modelAvailable`, not through a row here.
  // A preset (acpModelPreset) is a model of its own row, with its effort ladder, directly under its agent.
  const acpOptions: ProfileGridOption[] = acpAgents.filter((agent) => agent.available).flatMap((agent) => [
    {
      model: acpModelSlug(agent.id),
      label: agent.label,
      // No effort axis: an ACP agent runs on its own CLI's model and effort (ProfileGridSelector draws
      // one "Default" cell for an option with no efforts).
      efforts: [],
    },
    ...ACP_MODEL_PRESETS.filter((preset) => preset.agentId === agent.id).map((preset) => ({
      model: acpModelSlug(preset.agentId, preset.modelId),
      label: preset.label,
      defaultEffort: preset.defaultEffort,
      efforts: [...preset.efforts],
    })),
  ])
  return [
    {
      id: "claude",
      label: "Claude Code",
      options: claudeModelOptions(claudeModels).map((option) => ({
        model: option.value,
        label: option.label,
        edition: claudeModels.find((model) => model.alias === option.value)?.edition,
        defaultEffort: AUTO_EFFORT,
        // Per-model, exactly like the codex rows below: the ultracode rung exists only on the
        // xhigh-capable models, so Haiku's row leaves that grid cell empty. Auto leads every row: it picks from the rest of that row at dispatch.
        efforts: [AUTO_EFFORT, ...claudeEfforts(option.value)],
      })),
    },
    {
      id: "codex",
      label: "Codex",
      options: codexModels.map((model) => ({
        model: model.slug,
        label: model.displayName,
        defaultEffort: AUTO_EFFORT,
        efforts: [AUTO_EFFORT, ...model.efforts],
      })),
    },
    ...(acpOptions.length ? [{ id: "acp", label: "ACP agents", options: acpOptions }] : []),
  ]
}

export function resolveDispatchPreferences(
  preferences: DispatchPreferences,
  codexModels: readonly CodexModel[],
  acpAgents: readonly AcpAgent[] = [],
): ResolvedDispatchPreferences {
  const backend = preferences.backend
  // `acp` is optional on the record (older rows predate it), so an ACP backend with no saved profile
  // reads as an empty one and falls through to the first installed agent below.
  const profile = preferences[backend] ?? {}
  const firstAcpAgent = acpAgents.find((agent) => agent.available)
  const model = profile.model ?? (
    backend === "claude" ? "opus"
      : backend === "codex" ? codexModels[0]?.slug ?? ""
        : firstAcpAgent ? acpModelSlug(firstAcpAgent.id) : ""
  )
  const codexModel = backend === "codex"
    ? codexModels.find((candidate) => candidate.slug === model)
    : undefined
  const acpAgentId = backend === "acp" ? acpAgentIdFromModel(model) : undefined
  const acpModelId = backend === "acp" ? acpModelIdFromModel(model) : undefined
  const preset = backend === "acp" ? acpModelPreset(model) : undefined
  const pickerModel = backend === "acp" && acpAgentId && !preset ? acpModelSlug(acpAgentId) : model
  // An ACP profile is available when its AGENT is installed: the model inside it is the agent's to
  // honour or refuse (the bridge notes a refusal in the transcript), never a reason to block dispatch.
  const modelAvailable = backend === "claude"
    ? CLAUDE_MODELS.some((candidate) => candidate.value === model)
    : backend === "codex"
      ? codexModels.some((candidate) => candidate.slug === model)
      : acpAgents.some((candidate) => candidate.available && candidate.id === acpAgentId)
  // Auto unless the operator made another level the default: the server picks one from the prompt.
  const defaultEffort = backend === "claude" || codexModel ? AUTO_EFFORT : preset?.defaultEffort ?? ""
  // An ACP agent has no effort axis in ntwine — it runs on its own CLI's model and effort — so its
  // effort is "" and always "available": there is nothing to be unavailable. A preset has one.
  const effort = backend === "acp" && !preset ? "" : profile.effort ?? defaultEffort
  const autoOptions = [{ value: AUTO_EFFORT, label: "Auto" }]
  const baseEfforts = backend === "claude"
    ? [...autoOptions, ...claudeEffortOptions(model, { withDefault: false })]
    : backend === "codex" && codexModel
      ? [...autoOptions, ...codexEffortOptions(codexModel, { withDefault: false })]
      : preset ? preset.efforts.map((value) => ({ value, label: value })) : []
  const effortAvailable = (backend === "acp" && !preset) || baseEfforts.some((option) => option.value === effort)
  const effortOptions = effort && !effortAvailable
    ? [{ value: effort, label: `${effort} (unavailable)`, title: "Saved reasoning level is not available for this model" }, ...baseEfforts]
    : baseEfforts
  return {
    backend,
    model,
    pickerModel,
    effort,
    codexModel,
    ...(acpAgentId && !preset ? { acpAgentId } : {}),
    ...(acpModelId && !preset ? { acpModelId } : {}),
    modelAvailable,
    effortAvailable,
    effortOptions,
  }
}

export function dispatchModelGroups(
  codexModels: readonly CodexModel[],
  backend: Backend,
  selectedModel: string,
  claudeModels: readonly ClaudeModel[] = [],
): SelectGroup[] {
  const groups = modelGroups(codexModels, { withDefault: false }, claudeModels)
  if (!selectedModel || groups.some((group) => group.options.some((option) => option.value === selectedModel))) return groups
  const unavailable: SelectGroup = {
    label: backend === "codex" ? "Saved Codex model" : backend === "acp" ? "Saved ACP agent" : "Saved Claude model",
    options: [{ value: selectedModel, label: `${selectedModel} (unavailable)`, title: "This saved model is no longer in the runtime catalogue" }],
  }
  return [unavailable, ...groups]
}
