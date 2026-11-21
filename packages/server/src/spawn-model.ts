import { ACP_MODEL_PREFIX, ACP_MODEL_PRESETS, acpAgentIdFromModel, parseClaudeWireId, type Backend } from "@ntwine/shared"
import { CLAUDE_MODEL_ALIASES } from "./backend/claude-models.ts"

// A WORKER'S SPAWN NAMES ITS MODEL IN WORDS, AND THE WORDS HAVE TO MATCH THE BACKEND (2026-11-20).
//
// `spawn_thread` defaults to the Claude backend, and the Claude CLI takes whatever `--model` it is handed
// until the session starts. A Gemini worker (Antigravity, on `gemini-4-neon`) spawned an audit with
// `--model neon` and no backend: ntwine started a Claude thread on model "neon", and it died on launch with
// Claude Code's "There's an issue with the selected model (neon)". The human read that as a spent Gemini
// quota. So a worker's spawn is checked here, before anything starts: a model that unambiguously names its
// backend (`acp:<agent>@<model>`, a `gpt-` id) carries the backend with it, and a model the chosen backend
// does not carry is refused with the names it does — including the exact slug a Gemini name meant.
//
// Only a worker's spawn: the board's composer sends a model off its own picker, and a schedule's or a
// held thread's profile came from the same picker.

const CLAUDE_ALIAS = new RegExp(`^(${CLAUDE_MODEL_ALIASES.join("|")})(\\[1m\\])?$`, "u")

/** The ACP model slugs a bare name could have meant: an exact model id (`gemini-4-neon`) or its last word (`neon`). */
function acpSlugsMeant(model: string): string[] {
  const name = model.toLowerCase()
  return ACP_MODEL_PRESETS
    .filter((preset) => preset.modelId === name || preset.modelId.split("-").at(-1) === name || preset.label.toLowerCase().split(" ")[0] === name)
    .map((preset) => `${ACP_MODEL_PREFIX}${preset.agentId}@${preset.modelId}`)
}

function acpChoices(): string {
  return ACP_MODEL_PRESETS.map((preset) => `\`${ACP_MODEL_PREFIX}${preset.agentId}@${preset.modelId}\``).join(", ")
}

export type SpawnModel = { model: string; backend: Backend }

/** The backend a worker's spawn runs on, checked against its model. Throws a refusal naming the valid choices. */
export function spawnModelFor(model: string | undefined, backend: Backend | undefined): SpawnModel {
  const named = model?.trim() ?? ""
  if (!named) throw new Error("`model` is required. There is no default.")
  if (named.startsWith(ACP_MODEL_PREFIX)) {
    if (backend && backend !== "acp") throw new Error(`\`${named}\` is an ACP agent's model, so the backend is \`acp\`, not \`${backend}\`. Drop \`backend\` or set it to \`acp\`.`)
    if (!acpAgentIdFromModel(named)) throw new Error(`\`${named}\` names no agent. Use \`${ACP_MODEL_PREFIX}<agent>@<model>\`, for example ${acpChoices()}.`)
    return { model: named, backend: "acp" }
  }
  const claude = CLAUDE_ALIAS.test(named) || parseClaudeWireId(named) !== undefined
  if (claude && (!backend || backend === "claude")) return { model: named, backend: "claude" }
  const meant = acpSlugsMeant(named)
  if (backend === "acp" || meant.length) {
    const hint = meant.length ? `Did you mean ${meant.map((slug) => `\`${slug}\``).join(" or ")}? ` : ""
    throw new Error(`\`${named}\` is not a model ntwine can start${backend ? ` on the \`${backend}\` backend` : ""}. ${hint}An ACP agent's model is written \`${ACP_MODEL_PREFIX}<agent>@<model>\`: ${acpChoices()}.`)
  }
  if (backend === "codex") {
    if (claude) throw new Error(`\`${named}\` is a Claude model, not a Codex one. Drop \`backend\` to run it on Claude, or pick a Codex model id (\`gpt-…\`).`)
    return { model: named, backend }
  }
  if (!backend && named.startsWith("gpt-")) return { model: named, backend: "codex" }
  throw new Error(
    `\`${named}\` is not a Claude model. Claude: ${CLAUDE_MODEL_ALIASES.map((alias) => `\`${alias}\``).join(", ")}. ` +
      `Codex: a \`gpt-…\` model id. An ACP agent: ${acpChoices()}.`,
  )
}
