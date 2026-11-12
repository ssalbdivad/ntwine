// REWRITING A MOVED TRANSCRIPT'S MACHINE PATHS (plans/thread-handoff.md § 2).
//
// A thread that moves from `/Users/ssalb/ntwine` to `/home/ssalb/ntwine` carries a transcript full of
// the first machine's paths. Two kinds are rewritten, and only two:
//
// 1. STRUCTURAL fields the runtimes read back: every record's top-level `cwd`. Claude records the cwd per
//    message, and the board reads the newest one as the thread's working folder. Mapped by prefix, the
//    project checkout first (it is under the home), then the home.
// 2. REFERENCES TO FILES THAT MOVED WITH THE THREAD, wherever they appear: the session's own directory
//    (`<home>/.claude/projects/<bucket>/<session>…`, which oversized tool outputs are cited by) and the
//    attachments the human dropped in. These prefixes can only ever name a file that came along, so
//    rewriting them cannot change what any other sentence means.
//
// Everything else in the conversation is left exactly as written. Claude verifies the signature on each
// `thinking` block it is handed back, so a block that changed by one byte fails the resume; and a
// blanket `/Users/ssalb → /home/ssalb` rewrites meaning, not just location (the prompt that asked for
// this feature names both homes in one sentence). The worker is told the mapping instead, once, in the
// first message it receives on the new machine. `thinking` and `redacted_thinking` blocks are skipped
// by EVERY rule here, references included.

export interface PrefixMap {
  from: string
  to: string
}

export interface RelocationRules {
  /** Applied to top-level `cwd` fields, longest `from` first. */
  cwd: readonly PrefixMap[]
  /** Substring rewrites applied to every string outside thinking blocks. */
  refs: readonly PrefixMap[]
}

/** `from` itself, or anything under it — never a sibling that merely shares the prefix (`/a/bc` for `/a/b`). */
export function mapPrefix(value: string, maps: readonly PrefixMap[]): string {
  for (const { from, to } of [...maps].sort((a, b) => b.from.length - a.from.length)) {
    if (!from || from === to) continue
    if (value === from) return to
    if (value.startsWith(`${from}/`)) return `${to}${value.slice(from.length)}`
  }
  return value
}

function rewriteRefs(value: string, refs: readonly PrefixMap[]): string {
  let out = value
  for (const { from, to } of refs) {
    if (from && from !== to && out.includes(from)) out = out.split(from).join(to)
  }
  return out
}

const SIGNED_BLOCKS = new Set(["thinking", "redacted_thinking"])

function walk(value: unknown, refs: readonly PrefixMap[]): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const next = rewriteRefs(value, refs)
    return { value: next, changed: next !== value }
  }
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const result = walk(item, refs)
      changed ||= result.changed
      return result.value
    })
    return changed ? { value: next, changed } : { value, changed }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.type === "string" && SIGNED_BLOCKS.has(record.type)) return { value, changed: false }
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) {
      const result = walk(item, refs)
      changed ||= result.changed
      next[key] = result.value
    }
    return changed ? { value: next, changed } : { value, changed }
  }
  return { value, changed: false }
}

/**
 * One JSON record (a JSONL line, or a whole `.json` file). A line that is not JSON, or that no rule
 * touches, comes back byte for byte.
 */
export function relocateRecord(text: string, rules: RelocationRules): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text
  let record = parsed as Record<string, unknown>
  let changed = false
  if (typeof record.cwd === "string") {
    const cwd = mapPrefix(record.cwd, rules.cwd)
    if (cwd !== record.cwd) {
      record = { ...record, cwd }
      changed = true
    }
  }
  const walked = walk(record, rules.refs)
  if (!changed && !walked.changed) return text
  return JSON.stringify(walked.value)
}

/** A whole JSONL file. Line endings and a trailing newline are kept. */
export function relocateJsonl(text: string, rules: RelocationRules): string {
  return text.split("\n").map((line) => (line.trim() ? relocateRecord(line, rules) : line)).join("\n")
}
