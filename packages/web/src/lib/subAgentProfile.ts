const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"])

function splitEffort(value: string, separator: "/" | "-"): { model: string; effort?: string } {
  const at = value.lastIndexOf(separator)
  if (at <= 0) return { model: value }
  const effort = value.slice(at + 1)
  if (!EFFORTS.has(effort)) return { model: value }
  return { model: value.slice(0, at), effort }
}

// The server hands every surface one composed dispatch cell rather than separate profile fields:
//   Claude: ntwine:opus-high (and the equivalent legacy ntwine:ntwine-opus-high)
//   Codex:  explorer gpt-5.6-terra/high
//   either: general-purpose opus/high — a foreign agent type keeps its name and gains the pair
// The MODEL half is not always in what the provider recorded: a Claude profile has been effort-only
// since 2026-08-26 (the model rides the Agent tool's own parameter), so server/subagent-profile.ts
// folds it back in before this ever sees it — which is why an effort-only cell still reaches here in
// the legacy two-part shape and needs no branch of its own.
// Preserve an agent role when one exists, but present the model/effort with the same separators the
// normal prompt-box selector uses. Unknown/custom cells remain verbatim rather than being guessed.
export const PROFILE_NAMESPACE = /^ntwine:/
const PROFILE_ROUTE = /^ntwine-/

export function subAgentProfileLabel(subagentType?: string): string {
  const raw = subagentType?.trim()
  if (!raw) return "Profile unknown"

  const namespace = PROFILE_NAMESPACE.exec(raw)?.[0]
  if (namespace) {
    const routed = raw.slice(namespace.length).replace(PROFILE_ROUTE, "")
    const { model, effort } = splitEffort(routed, "-")
    return effort ? `${model} › ${effort}` : model
  }

  const words = raw.split(/\s+/)
  const cell = words.at(-1) ?? raw
  const { model, effort } = splitEffort(cell, "/")
  if (!effort) return raw
  const role = words.slice(0, -1).join(" ")
  return `${role ? `${role} · ` : ""}${model} › ${effort}`
}

// The same reading for a surface that must stay SILENT when nothing is known — the transcript's
// dispatch card, where "Profile unknown" would occupy a column on every legacy card to say nothing.
export function subAgentProfileCell(subagentType?: string): string | undefined {
  return subagentType?.trim() ? subAgentProfileLabel(subagentType) : undefined
}
