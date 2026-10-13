// The 1M context window: what ntwine asks for on every Claude dispatch, and why the ask always ships
// a fallback beside it.
//
// Claude Code turns a `[1m]` model suffix into the `context-1m-2025-08-07` beta header CLIENT-SIDE:
// `--model 'opus[1m]'` puts model=claude-opus-5 on the wire plus that header, where the bare alias
// sends no header at all. So the suffix never reaches the API as part of the model id — which is why
// an observed model still normalizes to the bare picker alias (see normalizeObservedThreadModel) and
// why the catalogue does NOT carry `[1m]` rows: the window is a launch property, not a model choice.
//
// The header is an OPT-IN, not the only path to the window — the window is granted by the
// SUBSCRIPTION. Measured 2026-08-18 on the maintainer's account through ntwine's own SDK transport,
// reading `result.modelUsage[…].contextWindow`:
//
//   model "opus"       → 1_000_000   ← already 1M with no suffix at all
//   model "opus[1m]"   → 1_000_000
//   model "sonnet"     → 1_000_000
//   model "haiku"      →   200_000
//   model "haiku[1m]"  →   HARD 400 — "The long context beta is not yet available for this
//                                      subscription." is_error, no result, session dead at launch.
//
// (Claude Code 2.1.293 moved `haiku` to Haiku 5.5, a 1M model. Measured 2026-10-08 on the same
// account: "haiku", "haiku[1m]" and "haiku[1m]" + fallback "haiku" each bill claude-haiku-5-5 at
// 1_000_000, with no 400. The haiku rows above are Haiku 4.5's.)
//
// That 400 row is the whole reason this module exists. The CLI applies the suffix BLINDLY: no model
// gating and no entitlement gating, and an unavailable beta does not quietly degrade to the small
// window — it kills the session before the first turn. Issue #19 reports a bare alias landing on
// 200_000 on a lower subscription tier, so asking for the window is worth doing; asking for it
// unconditionally would break every dispatch for anyone whose plan lacks the beta, which is strictly
// worse than compacting early.
//
// So every 1M request ships with the bare alias as `fallbackModel` (the SDK option; `--fallback-model`
// on the CLI). Claude Code retries the fallback when the primary is unavailable, and that covers this
// 400 exactly — measured: `--model 'haiku[1m]' --fallback-model haiku` returns is_error=false and
// bills claude-haiku-4-5 at its 200_000 window, where the same launch without the fallback dies.
// Entitled accounts get 1M; everyone else lands on precisely the session they get today. Claude
// re-tries the primary at the start of each user turn, so an account that later gains the entitlement
// picks it up without a relaunch.
//
// Haiku was excluded while it resolved to Haiku 4.5, which had no 1M to ask for (the 400 above was the
// haiku case). Since 2.1.293 it resolves to Haiku 5.5, so it is requested like the others — and an
// account whose `haiku` still resolves to 4.5 (a provider without 5.5) is caught by the fallback.

const WINDOW_SUFFIX = "[1m]"

// The aliases that have a 1M variant to request. Deliberately an exact-alias list: anything else — a
// full model id, a future alias, an operator's hand-typed value — is passed through untouched rather
// than guessed at, because a wrong suffix is a dead session, not a degraded one.
export const CLAUDE_1M_MODELS: readonly string[] = ["fable", "opus", "sonnet", "haiku"]

export interface ResolvedClaudeModel {
  /** The value to pass as `--model` / the SDK `model` option. */
  model: string
  /** The value to pass as `--fallback-model` / the SDK `fallbackModel` option, when 1M was requested. */
  fallbackModel?: string
}

/**
 * Translate a stored/selected picker alias into the model pair a spawn actually carries. Requests the
 * 1M window where one exists, ALWAYS paired with the bare alias as the fallback — the two must travel
 * together, exactly as ultracode's effort and setting must (see resolveClaudeEffort).
 */
export function resolveClaudeLaunchModel(model: string | undefined): ResolvedClaudeModel | undefined {
  if (!model) return undefined
  // An explicit `[1m]` (an operator-typed value, or a stored row from a build that wrote one) is
  // honoured rather than stripped — but it never travels without a fallback either.
  if (model.endsWith(WINDOW_SUFFIX)) {
    return { model, fallbackModel: model.slice(0, -WINDOW_SUFFIX.length) }
  }
  if (!CLAUDE_1M_MODELS.includes(model)) return { model }
  return { model: `${model}${WINDOW_SUFFIX}`, fallbackModel: model }
}
