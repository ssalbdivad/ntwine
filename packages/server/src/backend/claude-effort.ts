// Ultracode: the one Claude effort rung that is not an `--effort` value.
//
// Claude Code's effort flag accepts low|medium|high|xhigh|max and nothing else — an unrecognized value
// warns ("Unknown --effort value … using the default effort") and is dropped. Ultracode is instead a
// session-scoped BOOLEAN setting (`Settings.ultracode` in @anthropic-ai/claude-agent-sdk) meaning
// "xhigh effort plus standing dynamic-workflow orchestration", supplied via `--settings` on the CLI or
// the `settings` option on the SDK. ntwine still PRESENTS it as the top rung of the effort select,
// because that is exactly how Claude Code's own `/effort [low|…|max|ultracode|auto]` presents it — so
// this module is the single place that translates that rung into what a spawn actually accepts.
//
// The pairing below is LOAD-BEARING, not belt-and-braces. Claude's effort resolver returns the
// CLI/SDK effort BEFORE it consults `settings.ultracode`, so a launch effort of anything other than
// xhigh silently defeats the flag — the session comes up as an ordinary worker with no error. Measured
// on claude 2.1.220, one variable changed at a time:
//
//   claude -p --settings '{"ultracode":true}'                 → ultracode ON
//   claude -p --effort high  --settings '{"ultracode":true}'  → ultracode OFF   ← the trap
//   claude -p --effort xhigh --settings '{"ultracode":true}'  → ultracode ON
//
// ntwine sets an effort on every Claude dispatch, so the flag alone would never have worked.
export const CLAUDE_ULTRACODE = "ultracode"

// The effort ultracode actually runs at. Claude derives this itself when no launch effort is pinned,
// but ntwine always pins one, so we must pin the matching value (see above).
export const CLAUDE_ULTRACODE_EFFORT = "xhigh"

// Ultracode additionally requires an xhigh-capable model — Fable 5, Opus 4.7+, Sonnet 5 per the CLI's
// own capability string. Haiku is not one, and Claude ignores the flag there rather than failing:
// `--model haiku --settings '{"ultracode":true}'` reports ultracode OFF (measured). The effort grid
// omits the rung for those models so the UI never offers a level that would quietly do nothing.
export const CLAUDE_ULTRACODE_MODELS: readonly string[] = ["fable", "opus", "sonnet"]

export function claudeModelSupportsUltracode(model: string | undefined): boolean {
  return Boolean(model) && CLAUDE_ULTRACODE_MODELS.includes(model!)
}

export interface ResolvedClaudeEffort {
  /** The value to pass as `--effort` / the SDK `effort` option, or undefined to leave it unset. */
  effort?: string
  /** Whether this dispatch must also carry the `ultracode` session setting. */
  ultracode: boolean
}

/** Split a stored/selected Claude effort into the spawn's effort value + the ultracode session flag. */
export function resolveClaudeEffort(effort: string | undefined): ResolvedClaudeEffort {
  if (effort === CLAUDE_ULTRACODE) return { effort: CLAUDE_ULTRACODE_EFFORT, ultracode: true }
  return { effort, ultracode: false }
}

/** The settings blob a spawn carries for ultracode — the SDK `settings` option's value. */
export function claudeUltracodeSettings(): { ultracode: true } {
  return { ultracode: true }
}

/** The argv fragment carrying ultracode on the CLI transport (empty when it is not selected). */
export function claudeUltracodeFlags(resolved: ResolvedClaudeEffort): string[] {
  return resolved.ultracode ? ["--settings", JSON.stringify(claudeUltracodeSettings())] : []
}
