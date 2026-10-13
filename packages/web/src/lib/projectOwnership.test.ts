import assert from "node:assert/strict"
import test from "node:test"
import { ownedByThisPage } from "./projectOwnership.ts"

test("a payload is refused only when it NAMES a project and that project is not this page's", () => {
  assert.equal(ownedByThisPage("zod", "/all/zod/thread/x"), true)
  assert.equal(ownedByThisPage("zod", "/all/ntwine/thread/x"), false, "the whole point")
  assert.equal(ownedByThisPage("zod", "/all/zodiac/thread/x"), false, "a prefix is not a match")
})

// Both permissive cases are deliberate, and both would otherwise blank a working page. They are
// pinned because "tighten this up" is the obvious-looking edit that breaks the launching project.
test("silence is not evidence of a mismatch", () => {
  assert.equal(ownedByThisPage(undefined, "/all/zod/thread/x"), true, "a pre-restart server sends no slug")
  assert.equal(ownedByThisPage(null, "/all/zod/thread/x"), true)
  assert.equal(ownedByThisPage("zod", "/thread/x/full"), true, "the unprefixed launching project names none")
  assert.equal(ownedByThisPage("zod", "/"), true, "nor does a page with no focus yet")
})
