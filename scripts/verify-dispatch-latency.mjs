// Measure what `rpc/dispatch` costs BEFORE the worker exists — the dead time between the user
// pressing Enter and ntwine having done anything useful. This is the phase the auth-preflight and
// board-rebuild fixes target; the worker's own boot-to-first-transcript-byte is downstream of it and
// deliberately NOT measured here.
//
// Run against an isolated adhoc stack (scripts/adhoc-stack.mjs), never the maintainer's instance:
//   node scripts/adhoc-stack.mjs --port=4933 &     # note the url it prints
//   node scripts/verify-dispatch-latency.mjs http://127.0.0.1:4933/
//
// It dispatches real threads and then KILLS each spawned session, so nothing is left running.
import { createRpcClient } from "./lib/rpc-client.mjs"

const base = process.argv[2] ?? "http://127.0.0.1:4933/"
const runs = Number(process.argv[3] ?? 3)
const api = createRpcClient(base)

await api.waitForHealth()

// The preflight is prompt-independent, so keep the prompt trivial; we are timing ntwine, not the model.
const prompt = "reply with the single word ok"
const timings = []
const spawned = []

for (let i = 0; i < runs; i++) {
  const t0 = performance.now()
  let slug = null
  let error = null
  try {
    const out = await api.mutate("dispatch", { prompt, backend: "claude", title: `latency probe ${i}` })
    slug = out.slug
  } catch (err) {
    error = String(err.message ?? err)
  }
  const ms = Math.round(performance.now() - t0)
  timings.push(ms)
  if (slug) spawned.push(slug)
  console.log(`run ${i}: ${ms}ms${slug ? ` → ${slug}` : ` → ERROR ${error}`}`)
}

// Tear down every session this probe created, so an isolated stack teardown has nothing to orphan.
for (const slug of spawned) {
  try {
    await api.mutate("killAgent", { slug })
    console.log(`killed ${slug}`)
  } catch (err) {
    console.log(`could not kill ${slug}: ${err.message ?? err}`)
  }
}

const sorted = [...timings].sort((a, b) => a - b)
const median = sorted[Math.floor(sorted.length / 2)]
console.log(`\nrpc/dispatch: min ${sorted[0]}ms  median ${median}ms  max ${sorted[sorted.length - 1]}ms  (n=${runs})`)
// The preflight alone measured 5449ms on this machine before the fix, so anything at or above that
// means the CLI is back on the signed-in path.
console.log(median < 3000 ? "PASS — dispatch responds without waiting on the auth CLI" : "SLOW — check whether the auth CLI is back on the dispatch path")
process.exit(median < 3000 ? 0 : 1)
