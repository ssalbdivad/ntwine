// The composer's `/` typeahead, on the same footing as its `@` one (lib/threadMentions.ts): a `/` at a
// word boundary with the caret inside its token opens the menu, choosing a row completes that token in
// place, and a finished `/name` the thread can actually run is TINTED in the prompt box — in its own
// colour, so a skill never reads as a thread (David 2026-10-02: "autocomplete that works with the
// same mechanism as tagging other threads but uses a different highlight color").
//
// One asymmetry is the harness's, not ours. Claude runs a built-in COMMAND (`/context`, `/usage`) only
// when it OPENS the message; anywhere else it is plain text the model reads. A SKILL is invocable by
// name anywhere. So a command is offered, and tinted, only as the draft's first token, and a skill at
// any boundary — the tint never promises something the send will not do. A USER command
// (`~/.agents/commands/armstrong.md`) is ntwine's to expand, and it expands anywhere, so it rides as a skill.

import { insideCodeFence, type ThreadSkill } from "@ntwine/shared"

// A `/` after the start of the draft, whitespace or an opening bracket or quote — `(/commit first)`
// and `"/review"` name a skill as surely as a bare one does, and the `@` menu has always opened after
// them — then the token typed so far, up to the caret. A second `/` or an `@` ends it: `/tmp/foo` is a
// path and `/a@b` is not a name either. Not after a backtick: that is inline code.
const SLASH_BOUNDARY = String.raw`(?:^|[\s(\["'])`
const SLASH_BEFORE_CARET = new RegExp(`${SLASH_BOUNDARY}\\/([^\\s/@]*)$`, "u")
const SLASH_TOKEN_START = new RegExp(`${SLASH_BOUNDARY}\\/[^\\s/@]`, "u")

/** Whether the draft holds a started `/name` anywhere — the box then wants the list, to tint it. */
export function holdsSlashToken(prose: string): boolean {
  return SLASH_TOKEN_START.test(prose)
}

/** The `/` token the caret sits in, if any: where its slash is and what was typed after it. Never in a
 *  fenced code block, which the box paints as code and nothing in it runs. */
export function slashQueryAt(prose: string, caret: number | null): { start: number; query: string } | undefined {
  if (caret === null || caret > prose.length) return undefined
  const m = SLASH_BEFORE_CARET.exec(prose.slice(0, caret))
  if (!m) return undefined
  const start = caret - m[1]!.length - 1
  return insideCodeFence(prose)(start) ? undefined : { start, query: m[1]! }
}

/** Where the draft's first token starts — the one place a built-in command runs. */
export function draftStart(prose: string): number {
  return prose.length - prose.trimStart().length
}

/** The rows on offer for a query: prefix matches first (what completion usually wants), then substring
 *  matches, which surface a namespaced skill (`ntwine:gh`) from its bare name. Commands only when the
 *  token opens the draft. */
export function matchSlashItems(items: readonly ThreadSkill[], query: string, opensDraft: boolean): ThreadSkill[] {
  const q = query.toLowerCase()
  const offered = opensDraft ? items : items.filter((s) => !s.command)
  const starts = offered.filter((s) => s.name.toLowerCase().startsWith(q))
  const contains = offered.filter((s) => !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q))
  return [...starts, ...contains]
}

/** Complete the token at `start` (its `/`) to `/name`, replacing the WHOLE token — the part after the
 *  caret too, so completing mid-word never leaves a tail behind — and leave one space after it. */
export function insertSlashCommand(prose: string, start: number, caret: number, name: string): { prose: string; caret: number } {
  let end = caret
  while (end < prose.length && !/\s/.test(prose[end]!)) end++
  const after = prose.slice(end)
  const sep = /^\s/.test(after) ? "" : " "
  return { prose: `${prose.slice(0, start)}/${name}${sep}${after}`, caret: start + 1 + name.length + 1 }
}

export type SlashSegment = { kind: "text"; text: string } | { kind: "command"; text: string }

// A finished token: `/` at a boundary (SLASH_BOUNDARY), then a run with no whitespace or second slash.
// Sentence punctuation and a closing bracket or quote after it ("run /ntwine-stack, then…") are not
// part of the name.
const SLASH_TOKEN = /(^|[\s(\["'])(\/[^\s/@]+?)(?=[.,;!?)\]"']*(?:\s|$))/gu

/** `text` split into plain runs and the `/name` tokens that name something in `items`. `offset` is
 *  where `text` sits in the whole draft and `opensAt` is the draft's first-token index, so a command
 *  is recognised only where it would run. */
export function slashSegments(text: string, items: readonly ThreadSkill[], offset: number, opensAt: number): SlashSegment[] {
  if (items.length === 0 || !text.includes("/")) return [{ kind: "text", text }]
  const byName = new Map(items.map((s) => [s.name, s]))
  const out: SlashSegment[] = []
  let consumed = 0
  for (const m of text.matchAll(SLASH_TOKEN)) {
    const start = m.index! + m[1]!.length
    const token = m[2]!
    const item = byName.get(token.slice(1))
    if (!item || (item.command && offset + start !== opensAt)) continue
    if (start > consumed) out.push({ kind: "text", text: text.slice(consumed, start) })
    out.push({ kind: "command", text: token })
    consumed = start + token.length
  }
  if (consumed < text.length) out.push({ kind: "text", text: text.slice(consumed) })
  return out.length > 0 ? out : [{ kind: "text", text }]
}
