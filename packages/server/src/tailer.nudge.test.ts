// The nudge's SAFETY properties, separate from what it derives (that is covered end-to-end in
// integration/claude-runtime.integration.test.ts). A push signal wired to a provider's event stream
// is only an improvement if it cannot become its own stability problem: a turn emits events in
// bursts, and one whole-board tick per event is how you starve the event loop.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createTailer, newTailState, UNRESTORED_TAIL_FIELDS } from "./tailer.ts"
import { decodeTailState, encodeTailState } from "./tail-cache.ts"

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Ticks are counted through the registry read every tick begins with. That is deliberate: the nudge
// timer calls the tailer's INTERNAL tick, so wrapping the returned object's `tick` property would
// count nothing and every assertion here would pass vacuously.
//
// The count is a tight upper BOUND on ticks rather than an exact equality — a steady-state tick costs
// one registry read, and the every-fifth-tick foreign scan costs a second. That is more than enough
// resolution for what these tests are actually claiming: fifty events must not mean fifty ticks.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-nudge-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const reads = { n: 0 }
  const allSessions = storage.allSessions.bind(storage)
  storage.allSessions = ((...args: Parameters<typeof allSessions>) => {
    reads.n++
    return allSessions(...args)
  }) as typeof storage.allSessions
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage,
    bus: new Bus(),
    sessionLogDir: dir,
    onChange: () => {},
    paneDead: () => false,
  })
  tailer.tick() // prime, so the counter below measures steady-state ticks only
  reads.n = 0
  return { tailer, storage, reads }
}

test("nudge: a burst of fifty events collapses into one tick", async () => {
  const { tailer, storage, reads } = fixture()
  try {
    for (let i = 0; i < 50; i++) tailer.nudge?.()
    await wait(150)
    assert.ok(reads.n >= 1, "the burst did produce a tick")
    assert.ok(reads.n <= 2, `fifty events must not mean fifty whole-board ticks (registry reads: ${reads.n})`)
  } finally {
    tailer.stop()
    storage.close()
  }
})

test("nudge: coalescing is per-burst, not a permanent latch", async () => {
  const { tailer, storage, reads } = fixture()
  try {
    tailer.nudge?.()
    await wait(150)
    const afterFirst = reads.n
    assert.ok(afterFirst >= 1)
    tailer.nudge?.()
    await wait(150)
    assert.ok(reads.n > afterFirst, "a later event still gets its own tick")
  } finally {
    tailer.stop()
    storage.close()
  }
})

test("nudge: stop() cancels a pending nudge", async () => {
  const { tailer, storage, reads } = fixture()
  try {
    tailer.nudge?.()
    tailer.stop() // before the nudge timer could fire
    await wait(150)
    assert.equal(reads.n, 0, "a stopped tailer must not tick from a queued nudge")
  } finally {
    storage.close()
  }
})

test("chase bookkeeping is never restored from the durable cache", () => {
  // The chase counter is compared against an IN-MEMORY, per-process event count that restarts at zero
  // on every boot. Hydrating the previous process's high-water mark makes `live.events <=
  // runtimeEventsSeen` true forever, so the chase never fires again and the board silently falls back
  // to the 1s poll — measured at 968/970/970 ms against 16/22/19 ms once the field is dropped. That is
  // the whole latency win, reverted by a restart, with every existing test still green.
  //
  // Asserted against the REAL encode/decode round trip rather than by eyeballing the set, because the
  // cache codec is deliberately generic ("A hand-written field list is a standing bug") — so a new
  // TailState field is restored by DEFAULT, and only this exclusion stops it.
  const state = newTailState("t", "sid", "/x")
  state.runtimeEventsSeen = 1247
  state.runtimeChase = 19
  state.lastAssistant = "carried through"

  // The real codec, exercised the way hydrateFromCache does it: encode, decode, then copy back every
  // key the exclusion set does not stop.
  const decoded = decodeTailState(encodeTailState(state))!
  const restored = newTailState("t", "sid", "/x") as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(decoded)) {
    if (UNRESTORED_TAIL_FIELDS.has(k)) continue
    restored[k] = v
  }
  assert.equal(restored.lastAssistant, "carried through", "ordinary fold state still round-trips")
  assert.equal(restored.runtimeEventsSeen, undefined, "a previous process's event count must not survive a restart")
  assert.equal(restored.runtimeChase, undefined, "a mid-chase counter must not survive a restart")
})

test("nudge: nudging a stopped tailer is inert", async () => {
  const { tailer, storage, reads } = fixture()
  try {
    tailer.nudge?.()
    await wait(150)
    const afterFirst = reads.n
    tailer.stop()
    tailer.nudge?.()
    await wait(150)
    assert.equal(reads.n, afterFirst)
  } finally {
    storage.close()
  }
})
