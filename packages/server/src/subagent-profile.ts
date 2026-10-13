import { eitherBrand } from "@ntwine/shared"
import { normalizeObservedThreadModel } from "./backend/thread-profiles.ts"

// THE DISPATCH PROFILE CELL — the one string every surface that names a sub-agent reads its model and
// effort off (the transcript's dispatch card, the drawer's readout, the rail row tooltip, the resting
// card's child line). It is composed here, on the server, for the same reason the codex spawn cell is
// (`describeCell` in codex-subagents.ts, `codexAgentCell` in transcript.ts): a reader wants ONE cell
// naming the runtime, and deriving it per surface is how two of them come to disagree.
//
// Why it needs composing at all: until 2026-08-26 a Claude dispatch named both halves in one string
// (`ntwine:opus-high`), so `subagent_type` verbatim WAS the cell. Splitting the profiles to effort-only
// (`ntwine:high`, the model on the Agent tool's own `model` parameter — commit e6f30cf8) left every one
// of those surfaces reading an effort with no model beside it, and the model recorded nowhere at all.
// This puts it back in the canonical form the parsers already speak, so nothing downstream had to learn
// a second shape (web/lib/subAgentProfile.ts renders both, and has since before the split).
//
// AN OMITTED `model` IS NOT AN UNKNOWN ONE — for a profile ntwine itself ships. The Agent tool resolves
// an omitted model to "the agent definition's model, or inherits from the parent", and ntwine's own
// `ntwine:<effort>` definitions pin effort ONLY (cc-worker/agents/*.md), so for those the parent's is
// the answer. The dispatching assistant record states exactly what the parent was running
// (`message.model` on 33493/33493 records measured across this machine's corpus, `effort` on 33430),
// so the cell resolves from that TURN rather than the session's current profile: a thread whose model
// changed mid-run still reads each dispatch at the model it actually launched under.
//
// A FOREIGN agent type inherits NOTHING here. `general-purpose`, `Explore` or a project's own
// `.claude/agents/*.md` may pin a model or effort ntwine cannot see, and a cell that guessed the
// parent's would state a runtime the child never ran at. Such a dispatch keeps its type name and shows
// only what the call itself named — which is still everything the card showed before this existed.
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra", "ultracode"])

// Claude writes `<synthetic>` as the model on the records it fabricates itself (an API-error bubble).
// Nothing was dispatched at that model and no child could inherit it.
const SYNTHETIC_MODEL = "<synthetic>"

interface DispatchProfileInput {
  /** `input.subagent_type` verbatim — the profile name, which may itself carry model and/or effort. */
  subagentType?: unknown
  /** `input.model` verbatim — the dispatch's explicit model, when the caller named one. */
  model?: unknown
  /** `message.model` of the assistant record that made the dispatch — what an omitted model inherits. */
  turnModel?: unknown
  /** `effort` of that same record — what a profile carrying no effort of its own inherits. */
  turnEffort?: unknown
}

/** The profile name's own halves. A modern cell is effort-only; a legacy one pinned the model too. */
function splitNtwineProfile(routed: string): { model?: string; effort?: string } {
  if (EFFORTS.has(routed)) return { effort: routed }
  const at = routed.lastIndexOf("-")
  if (at <= 0) return { model: routed }
  const effort = routed.slice(at + 1)
  return EFFORTS.has(effort) ? { model: routed.slice(0, at), effort } : { model: routed }
}

/** Provider payloads reach both callers untyped, so every field is narrowed rather than trusted. */
function text(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

function shortModel(raw: unknown): string | undefined {
  const value = text(raw)
  if (!value || value === SYNTHETIC_MODEL) return undefined
  // `claude-opus-5` → `opus`, so an inherited model reads in the same words the picker and an explicit
  // `model: "opus"` use. An id the catalogue doesn't know survives verbatim rather than being dropped.
  return normalizeObservedThreadModel("claude", value) ?? value
}

/**
 * The cell for one Claude `Agent` dispatch, or `undefined` when nothing is known about its runtime.
 * Shapes out, all of which web/lib/subAgentProfile.ts already renders:
 *   ntwine:opus-high             an ntwine profile (or no profile at all) with both halves resolved
 *   general-purpose opus/high   a foreign agent type, which keeps its name and gains what the call named
 *   ntwine:high                  the model genuinely unknown — the profile verbatim, as before
 */
const PROFILE_NAMESPACE = eitherBrand(/^ntwine:/)
const PROFILE_ROUTE = eitherBrand(/^ntwine-/)

export function dispatchProfileCell(input: DispatchProfileInput): string | undefined {
  const type = text(input.subagentType)
  // Either product name's namespace: a transcript from before the rename has the old one (legacy-frizz.ts).
  const namespace = type ? PROFILE_NAMESPACE.exec(type)?.[0] : undefined
  const namespaced = namespace !== undefined
  const ours = namespaced || !type
  const fromType = namespaced ? splitNtwineProfile(type!.slice(namespace.length).replace(PROFILE_ROUTE, "")) : {}
  // Explicit beats the profile's own pin, which beats inheritance — the order the runtime resolves them,
  // and the last of the three is offered only for a profile whose definition we know pins nothing.
  const model = shortModel(input.model) ?? fromType.model ?? (ours ? shortModel(input.turnModel) : undefined)
  const effort = fromType.effort ?? (ours ? text(input.turnEffort) : undefined)
  if (!model && !effort) return type
  const pair = model && effort ? `${model}/${effort}` : (model ?? effort)!
  // An ntwine profile and a bare dispatch both speak the namespaced form; anything else is an agent type
  // with a name worth keeping, so the pair joins it the way a codex spawn's role does.
  if (ours) return `ntwine:${[model, effort].filter(Boolean).join("-")}`
  return `${type} ${pair}`
}
