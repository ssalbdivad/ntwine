import { test } from "node:test"
import assert from "node:assert/strict"
import type { EditorWindowSummary } from "@ntwine/shared"
import { reviewLabel } from "./reviewChanges.ts"

const window = (over: Partial<EditorWindowSummary> = {}): EditorWindowSummary => ({ app: "Visual Studio Code", kind: "vscode", acceptsOpens: true, reviews: true, ...over })

test("in the editor's sidebar the action is always there, and says nothing about where — it is here", () => {
  assert.equal(reviewLabel([], true), "Review changes")
})

test("in a browser it exists only while an editor that can show the changes is connected and takes them", () => {
  assert.equal(reviewLabel([], false), null)
  // An extension from before the feature never says it can; a window with opens off takes nothing.
  assert.equal(reviewLabel([window({ reviews: undefined })], false), null)
  assert.equal(reviewLabel([window({ acceptsOpens: false })], false), null)
  assert.equal(reviewLabel([window()], false), "Review changes in VS Code")
  assert.equal(reviewLabel([window({ app: "Cursor", kind: "cursor" }), window({ reviews: undefined })], false), "Review changes in Cursor")
})

test("two kinds of editor that could take it: the label does not guess which", () => {
  assert.equal(reviewLabel([window(), window({ app: "Cursor", kind: "cursor" })], false), "Review changes in your editor")
  assert.equal(reviewLabel([window({ app: "VSCodium", kind: "other" })], false), "Review changes in your editor")
})
