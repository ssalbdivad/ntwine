import assert from "node:assert/strict"
import test from "node:test"
import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ListTodo } from "lucide-react"
import { TranscriptCard } from "./TranscriptCard.tsx"

// THE KIND CHIP (2026-10-05) — the card family's second head shape, worn by the steps card. Pinned here
// as STRUCTURE: which pieces a card draws and in what order. The spacing those pieces were measured for
// lives in their classes and is judged in a browser, where AwaitingSteps.e2e.test.ts draws the real card.
const html = (props: ComponentProps<typeof TranscriptCard>) => renderToStaticMarkup(createElement(TranscriptCard, props))
const at = (out: string, marker: string) => {
  const i = out.indexOf(marker)
  assert.notEqual(i, -1, `${marker} is drawn`)
  return i
}

test("a chipped card names its kind in a chip, puts the title under it, and rules the body off", () => {
  const out = html({ icon: ListTodo, chip: "Awaiting human", label: "Sign in to npm", children: "Run the login." })
  // The glyph rides INSIDE the chip, ahead of the kind — not beside the title, as a plain head draws it.
  assert.match(out, /<span data-card-chip[^>]*><svg[^>]*lucide-list-todo[^>]*>.*?<\/svg>Awaiting human<\/span>/)
  assert.doesNotMatch(out, /card-icon-offset/, "no title-row glyph beside the chip")
  // Chip, then the title on its own line, then the rule, then the body.
  const chip = at(out, "data-card-chip")
  const title = at(out, "data-card-title")
  const rule = at(out, "data-card-rule")
  const body = at(out, "Run the login.")
  assert.ok(chip < title && title < rule && rule < body, "chip → title → rule → body")
  assert.match(out, /data-card-title[^>]*>Sign in to npm</)
})

test("a chip alone can head the card, and a card with no body draws no rule", () => {
  // Untitled: the chip already says what the card is for, so no empty title line is spent.
  const untitled = html({ icon: ListTodo, chip: "Awaiting human", label: null, children: "Run the login." })
  assert.doesNotMatch(untitled, /data-card-title/)
  assert.ok(at(untitled, "data-card-chip") < at(untitled, "data-card-rule"))
  // Bodiless: there is nothing to rule off.
  assert.doesNotMatch(html({ icon: ListTodo, chip: "Awaiting human", label: "Sign in to npm" }), /data-card-rule/)
})

test("a card without a chip keeps the glyph-beside-title head", () => {
  const out = html({ icon: ListTodo, label: "Awaiting", children: "Waiting for an external update." })
  assert.doesNotMatch(out, /data-card-chip|data-card-rule|data-card-title/)
  assert.match(out, /<svg[^>]*card-icon-offset[^>]*>.*?<\/svg><span[^>]*>Awaiting<\/span>/)
})
