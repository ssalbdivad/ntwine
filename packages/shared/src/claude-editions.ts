// Claude model EDITIONS — "Opus 5.5" rather than "opus" — read off the canonical wire id, on both sides
// of the wire. The server reads them to label the picker from the pinned runtime (claude-models.ts) and
// to decide when a thread's worker has fallen behind its family; the browser reads them to put the
// edition a thread actually RUNS on its composer's model control. One parser, so the two cannot drift.

export type ClaudeModelFamily = "fable" | "opus" | "sonnet" | "haiku"

export interface ClaudeWireId {
  /** The `claude --model` alias this id belongs to — the family Ntwine keys every preference on. */
  alias: ClaudeModelFamily
  /** "5.5", "5", "4.5" — the edition within the family. */
  edition: string
  /** The id without its context-window suffix. */
  resolvedModel: string
}

// A canonical Claude wire id → its family and edition: `claude-opus-5-5` → opus 5.5, `claude-sonnet-5`
// → sonnet 5, `claude-haiku-4-5-20251001` → haiku 4.5 (the 8-digit date is a snapshot, not an edition),
// `claude-fable-5-1[1m]` → fable 5.1 (the 1M suffix is a context window, not a model). Anything else
// answers undefined rather than a guessed label.
const WIRE_ID = /^claude-(fable|opus|sonnet|haiku)-(\d+(?:-\d+)*?)(?:-\d{8})?(?:\[1m\])?$/
export function parseClaudeWireId(id: string): ClaudeWireId | undefined {
  const m = WIRE_ID.exec(id.trim())
  if (!m) return undefined
  return { alias: m[1] as ClaudeModelFamily, edition: m[2]!.split("-").join("."), resolvedModel: id.trim().replace(/\[1m\]$/, "") }
}

/** "Opus" for `opus` — the family word the picker shows beside an edition. */
export function claudeFamilyLabel(alias: string): string {
  return alias.charAt(0).toUpperCase() + alias.slice(1)
}

/** Is edition `a` strictly newer than edition `b`? Numeric per dotted segment, so 5.10 is newer than 5.9
 *  and 5.5 is newer than 5; a missing segment reads as 0. */
export function claudeEditionIsNewer(a: string, b: string): boolean {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  if (left.some((n) => !Number.isFinite(n)) || right.some((n) => !Number.isFinite(n))) return false
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l > r
  }
  return false
}
