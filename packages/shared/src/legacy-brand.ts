// THE RENAME IN STORED TEXT: this product was Frizz until 2026-10-13, and everything it wrote into a
// transcript before then — markers, wake tokens, notices, trailers — spells the name that way. Every
// recognizer that reads stored text matches both spellings through these two helpers, so the old
// spelling is derived from the current constant and the two cannot drift.

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
