import { test } from "node:test"
import assert from "node:assert/strict"
import { type } from "./ark.ts"
import { DispatchInput, Settings } from "./index.ts"

// The two zod defaults arktype does not share, each held where the migration put it (ark.ts).

test("an optional key takes an explicit undefined, as its TypeScript type says it may", () => {
  const out = DispatchInput({ prompt: "x", title: undefined, slug: undefined })
  if (out instanceof type.errors) assert.fail(out.summary)
  assert.deepEqual(out, { prompt: "x", title: undefined, slug: undefined })
})

test("a stored Settings blob loses a retired key on parse, and keeps every declared one", () => {
  const out = Settings({ permissionMode: "auto", notifications: true, font: "mono", homeFolder: "/h" })
  if (out instanceof type.errors) assert.fail(out.summary)
  assert.deepEqual(out, { permissionMode: "auto", notifications: true })
})
