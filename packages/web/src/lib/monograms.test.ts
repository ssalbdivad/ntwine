import assert from "node:assert/strict"
import test from "node:test"
import { distinctMonograms } from "./monograms.ts"

const letters = (projects: { id: string; name: string }[]) => Object.fromEntries([...distinctMonograms(projects)].map(([id, m]) => [id, m]))

test("a collision is resolved in id order, the later project taking its next free letter", () => {
  assert.deepEqual(letters([{ id: "b", name: "look4" }, { id: "a", name: "local" }, { id: "c", name: "ntwine" }]), { a: "LO", b: "LK", c: "NT" })
})

test("a resolved collision never takes another project's own monogram", () => {
  // `logs` would take LG next, but `lg` owns LG: it skips to LS.
  assert.deepEqual(letters([{ id: "a", name: "local" }, { id: "b", name: "logs" }, { id: "c", name: "lg" }]), { a: "LO", b: "LS", c: "LG" })
})

test("identical names keep their monogram, having nothing else to differ by but hue", () => {
  assert.deepEqual(letters([{ id: "a", name: "app" }, { id: "b", name: "app" }]), { a: "AP", b: "AP" })
})
