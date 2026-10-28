// The worker-plugin closure assertion, run as the SOURCE'S OWN script.
//
// artifacts.ts used to make this assertion itself, with the list compiled into whatever build happened
// to be RUNNING. During Update & Restart that build is the OLD one and the tree it inspects is the NEW
// checkout, so the two disagree the moment the list changes — and a NARROWING deadlocks the update
// outright. On 2026-08-26 `dafe4309` deleted cc-worker/bin/browser-mcp.mjs and its closure entry in one
// commit, correctly; every instance built before it then refused to update, naming a file the new source
// is right not to have ("ntwine worker plugin closure is missing cc-worker/bin/browser-mcp.mjs"), and the
// only way past was a restart from a terminal. Update & Restart is the one control that moves an instance
// forward, which is why promoteCurrentSourceArtifact already refuses to make the artifact it REPLACES a
// precondition — this is the same rule pointed at the source rather than at the rollback slot.
//
// So the list must come from the tree it describes. Nub runs this out of the captured snapshot, which
// makes `../src/worker-plugin-closure.ts` the new source's own opinion rather than the running server's.
//
// Usage: node scripts/assert-worker-plugin-closure.mjs <staged runtime/ tree, or the repo root it mirrors>
import { assertWorkerPluginClosure } from "../src/worker-plugin-closure.ts"

const [root] = process.argv.slice(2)
if (!root) throw new Error("usage: assert-worker-plugin-closure.mjs <root>")

try {
  assertWorkerPluginClosure(root)
} catch (error) {
  // The message, not the stack: it is surfaced verbatim on the board's update-failure card, and the
  // operator reading it needs the missing path on the first line rather than below a Node trace.
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
