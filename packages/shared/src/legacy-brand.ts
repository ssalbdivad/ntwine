// LEGACY — THE RENAME IN STORED TEXT: this product was Frizz until 2026-10-13, and everything it wrote into
// a transcript before then — markers, wake tokens, notices, trailers, the completion relay's idempotence
// marker — spells the name that way. Every recognizer that reads stored text matches both spellings through
// these helpers, so the old spelling is derived from the current constant and the two cannot drift.
//
// The frizz migration (packages/server/src/frizz-migration.ts) cannot retire this one: the text lives in
// Claude Code's and Codex's own transcripts, which Ntwine reads and never rewrites (discover.ts), and a
// worker started before the rename keeps writing it there until it exits.
//
// REMOVE once no thread whose transcript predates the rename can be rendered or resumed: every such
// thread deleted, or the board taught to show them unparsed.
/** `text` as Ntwine wrote it before the rename. */
export function frizzWording(text: string): string {
  return text.replaceAll("Ntwine", "Frizz").replaceAll("ntwine", "frizz").replaceAll("NTWINE", "FRIZZ")
}

/** Every spelling stored text may carry `text` in: today's, then the pre-rename one when it differs. */
export function brandSpellings(text: string): string[] {
  const old = frizzWording(text)
  return old === text ? [text] : [text, old]
}

/** `re`, matching the product's name in either spelling wherever its source names it. */
export function eitherBrand(re: RegExp): RegExp {
  return new RegExp(
    re.source.replace(/NTWINE|Ntwine|ntwine/g, (name) => `(?:${name}|${frizzWording(name)})`),
    re.flags,
  )
}
