import type { AcpAgentModels } from "@ntwine/shared"
import type { SelectGroup, SelectOption } from "../components/ui/Select.tsx"

// The rows of the model dropdown on an ACP thread, GROUPED BY PROVIDER (maintainer 2026-09-16: "we
// should definitely group these by provider"). An agent's model list spans providers — OpenCode
// advertises OpenAI, xAI and its own Zen models in one flat list of 34 — and each name carries its
// provider as a prefix ("OpenAI/GPT-5.5", id "openai/gpt-5.5"), so the prefix becomes the section
// header and the row keeps only the model's own name.
//
// The first section has no header and holds value "" — the agent's OWN default: Ntwine asks for nothing
// and the agent opens on whatever its config names — so a thread never has to name a model to run. The
// list itself comes from the agent (session/new advertises it as a config option), so it is exactly
// what the agent will honour: an OpenCode signed into one provider lists that provider's models and
// nothing else.
export function acpModelGroups(models: AcpAgentModels | undefined, savedModelId: string | undefined): SelectGroup[] {
  const current = models?.models.find((model) => model.id === models.current)
  const lead: SelectOption[] = [{
    value: "",
    label: current ? `Default · ${splitProvider(current).model}` : "Default",
    title: "The model the agent opens on when Ntwine asks for none",
  }]
  // A saved model the agent no longer lists stays VISIBLE and verbatim rather than snapping to
  // Default: the operator chose it, and the bridge will note the refusal in the transcript if the
  // agent declines it. While the list is still loading (or failed) nothing is known either way, so
  // the saved id is shown as-is without the "(unavailable)" verdict.
  if (savedModelId && !models?.models.some((model) => model.id === savedModelId)) {
    lead.push(models && !models.error
      ? { value: savedModelId, label: `${savedModelId} (unavailable)`, title: "The agent no longer advertises this model" }
      : { value: savedModelId, label: savedModelId })
  }
  const groups: SelectGroup[] = [{ label: "", options: lead }]
  // Providers in order of first appearance — the agent's own order, which puts its preferred provider
  // first — rather than alphabetical.
  for (const model of models?.models ?? []) {
    const { provider, model: name } = splitProvider(model)
    let group = groups.find((candidate) => candidate.label === provider)
    if (!group) { group = { label: provider, options: [] }; groups.push(group) }
    group.options.push({ value: model.id, label: name, title: model.id })
  }
  return groups
}

// "OpenAI/GPT-5.5" → OpenAI + GPT-5.5. A name with no slash falls back to its id's prefix
// ("anthropic/…" → "anthropic"), and a bare id with neither is filed under "Models".
function splitProvider(model: { id: string; name: string }): { provider: string; model: string } {
  const slash = model.name.indexOf("/")
  if (slash > 0) return { provider: model.name.slice(0, slash).trim(), model: model.name.slice(slash + 1).trim() }
  const idSlash = model.id.indexOf("/")
  if (idSlash > 0) return { provider: model.id.slice(0, idSlash), model: model.name }
  return { provider: "Models", model: model.name }
}
