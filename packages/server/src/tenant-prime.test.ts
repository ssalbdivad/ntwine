import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import test from "node:test"
import { startTenantPrime, type PrimeCandidate, type TenantPrimeDeps, type TenantPrimeRun } from "./tenant-prime.ts"
import type { Project } from "./project.ts"

// The background pass that opens every registered project after boot, so the rail can badge all of
// them instead of only the ones the operator has clicked into. Every wait is injected away here: the
// real gaps are seconds, and none of them is what these assert.

const candidate = (id: string, over: Partial<PrimeCandidate> = {}): PrimeCandidate =>
  ({ id, path: `${tmpdir()}/${id}`, stale: false, ...over })

const project = (entry: PrimeCandidate): Project =>
  ({ id: entry.id, dir: entry.path, stateDir: entry.path, name: entry.id, label: entry.id, cwdSlug: entry.id }) as Project

function harness(over: Partial<TenantPrimeDeps> = {}) {
  const opened: string[] = []
  const logs: string[] = []
  const deps: TenantPrimeDeps = {
    list: () => [candidate("a"), candidate("b"), candidate("c")],
    isOpen: () => false,
    toProject: project,
    activate: async (p) => {
      opened.push(p.id)
      return {}
    },
    delay: async () => {},
    log: (message) => logs.push(message),
    ...over,
  }
  return { deps, opened, logs }
}

test("opens every registered project, in rail order", async () => {
  const { deps, opened } = harness()
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["a", "b", "c"])
  assert.deepEqual(result.opened, ["a", "b", "c"])
  assert.deepEqual(result.failed, [])
})

test("skips the projects already open here — the launching one above all", async () => {
  const { deps, opened } = harness({ isOpen: (id) => id === "a" })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["b", "c"])
  assert.deepEqual(result.skipped, ["a"])
})

test("skips a project whose directory is gone rather than failing to open it", async () => {
  const { deps, opened } = harness({ list: () => [candidate("a", { stale: true }), candidate("b")] })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["b"])
  assert.deepEqual(result.skipped, ["a"])
  assert.deepEqual(result.failed, [])
})

test("leaves a project another live Ntwine is serving closed, and says so once", async () => {
  const { deps, opened, logs } = harness({ servedElsewhere: (p) => (p.id === "b" ? 4242 : undefined) })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["a", "c"])
  assert.deepEqual(result.skipped, ["b"])
  assert.equal(logs.filter((line) => line.includes("4242")).length, 1)
})

test("a project that will not open is one missing badge, not the end of the pass", async () => {
  // `undefined` is exactly what the tenant seam resolves for a project it could not build.
  const { deps, opened } = harness({
    activate: async (p) => {
      opened.push(p.id)
      return p.id === "a" ? undefined : {}
    },
  })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["a", "b", "c"])
  assert.deepEqual(result.failed, ["a"])
  assert.deepEqual(result.opened, ["b", "c"])
})

test("an activation that THROWS is caught too — the pass is a floating promise", async () => {
  const { deps, opened, logs } = harness({
    activate: async (p) => {
      opened.push(p.id)
      if (p.id === "b") throw new Error("board stopped")
      return {}
    },
  })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["a", "b", "c"])
  assert.deepEqual(result.failed, ["b"])
  assert.ok(logs.some((line) => line.includes("board stopped")))
})

test("a registry entry that will not resolve is stepped over", async () => {
  const { deps, opened } = harness({
    toProject: (entry) => {
      if (entry.id === "a") throw new Error("unreadable state dir")
      return project(entry)
    },
  })
  const result = await startTenantPrime(deps).done
  assert.deepEqual(opened, ["b", "c"])
  assert.deepEqual(result.failed, ["a"])
})

test("stop() halts the pass, so shutdown never races an activation into a drained map", async () => {
  let run: TenantPrimeRun
  const opened: string[] = []
  const deps: TenantPrimeDeps = {
    list: () => [candidate("a"), candidate("b"), candidate("c")],
    isOpen: () => false,
    toProject: project,
    activate: async (p) => {
      opened.push(p.id)
      if (p.id === "a") run.stop()
      return {}
    },
    delay: async () => {},
    log: () => {},
  }
  run = startTenantPrime(deps)
  const result = await run.done
  assert.deepEqual(opened, ["a"])
  assert.deepEqual(result.opened, ["a"])
})

test("stop() before the first project opens nothing at all", async () => {
  const { deps, opened } = harness()
  const run = startTenantPrime(deps)
  run.stop()
  const result = await run.done
  assert.deepEqual(opened, [])
  assert.deepEqual(result.opened, [])
})

test("the pause between projects tracks the last activation, clamped at both ends", async () => {
  // The pacing is a 50% duty cycle on a measured cost, not a flat guess — an empty project (13ms here)
  // costs the 25ms floor, a middling one is paid back exactly, and a big board earns a breather its own
  // size until the ceiling. The first project waits only the opening delay: there is nothing to be
  // polite about yet.
  //
  // FOUR projects, because three could not reach the question. The gap is taken BEFORE an activation,
  // so a list ending at the expensive project never spends the gap that project earned — which is how
  // the ceiling went untested through the whole of the 250ms era, with this comment claiming it was
  // "capped at the 250ms ceiling" while nothing asserted it. `d` is here to spend `c`'s gap.
  const waits: number[] = []
  let clock = 0
  const costs = new Map([["a", 13], ["b", 90], ["c", 800], ["d", 5]])
  const result = await startTenantPrime({
    list: () => [candidate("a"), candidate("b"), candidate("c"), candidate("d")],
    isOpen: () => false,
    toProject: project,
    activate: async (p) => {
      clock += costs.get(p.id)!
      return {}
    },
    monotonicNow: () => clock,
    startDelayMs: 250,
    delay: async (ms) => void waits.push(ms),
    log: () => {},
  }).done
  assert.deepEqual(result.tookMs, [13, 90, 800, 5])
  // 800 is paid back in full: it is under PRIME_MAX_GAP_MS, which is what a 50% duty cycle MEANS for a
  // real activation on this machine (the maintainer's boot log ranges 111-1000ms). It was clamped to 250
  // before 2026-09-04, an 80% duty cycle that kept the loop saturated for the whole priming pass.
  assert.deepEqual(waits, [250, 25, 90, 800])
})

test("resolving a project is blocking work, so its cost is paced against too", async () => {
  // `toProject` shells out to `git remote get-url`, synchronously, at a 110ms median under load. It used
  // to sit entirely outside the measured span, so a project that cost 300ms to resolve and 100ms to
  // activate was logged and paced as 100ms. Both halves block the same loop and both are counted now.
  //
  // The gap must NOT be: it sits between the two halves, and folding a politeness wait into the cost
  // that decides the next politeness wait would make each project pace off the last one's idling.
  const waits: number[] = []
  let clock = 0
  const result = await startTenantPrime({
    list: () => [candidate("a"), candidate("b")],
    isOpen: () => false,
    toProject: (entry) => {
      clock += 300
      return project(entry)
    },
    activate: async () => {
      clock += 100
      return {}
    },
    monotonicNow: () => clock,
    startDelayMs: 250,
    delay: async (ms) => {
      // Advance the clock across the wait, the way real time does — this is what catches a span that
      // wrongly encloses the gap.
      clock += ms
      waits.push(ms)
    },
    log: () => {},
  }).done
  assert.deepEqual(result.tookMs, [400, 400], "300ms of resolution plus 100ms of activation")
  assert.deepEqual(waits, [250, 400], "the gap tracks resolve+activate, and is not itself counted")
})

test("one pathological activation cannot pace the whole rail — the gap is still bounded", async () => {
  // The ceiling's real job: a project that somehow takes half a minute must not buy itself half a
  // minute of silence and hold every remaining badge hostage. Raising it to 1500ms honoured the duty
  // cycle for activations that actually happen; it did not remove the bound.
  const waits: number[] = []
  let clock = 0
  const costs = new Map([["a", 30_000], ["b", 5]])
  await startTenantPrime({
    list: () => [candidate("a"), candidate("b")],
    isOpen: () => false,
    toProject: project,
    activate: async (p) => {
      clock += costs.get(p.id)!
      return {}
    },
    monotonicNow: () => clock,
    startDelayMs: 250,
    delay: async (ms) => void waits.push(ms),
    log: () => {},
  }).done
  assert.deepEqual(waits, [250, 1_500], "a 30s activation must be clamped, not paid back in full")
})

test("a run of skips costs no pause at all — only an activation earns one", async () => {
  const waits: number[] = []
  const result = await startTenantPrime({
    list: () => [candidate("open"), candidate("gone", { stale: true }), candidate("a")],
    isOpen: (id) => id === "open",
    toProject: project,
    activate: async () => ({}),
    monotonicNow: () => 0,
    startDelayMs: 250,
    delay: async (ms) => void waits.push(ms),
    log: () => {},
  }).done
  assert.deepEqual(result.opened, ["a"])
  assert.deepEqual(waits, [250], `a skip paced the pass: ${JSON.stringify(waits)}`)
})

test("the real timer is interruptible, so a shutdown during the opening wait settles at once", async () => {
  // No injected delay: this is the shipped wait, cut short by stop(). Without the interrupt the
  // shutdown phase would block for the full opening delay on every server that has just booted.
  const started = Date.now()
  const run = startTenantPrime({
    list: () => [candidate("a")],
    isOpen: () => false,
    toProject: project,
    activate: async () => ({}),
    startDelayMs: 30_000,
    log: () => {},
  })
  run.stop()
  const result = await run.done
  assert.deepEqual(result.opened, [])
  assert.ok(Date.now() - started < 1_000, "stop() did not cut the opening wait short")
})

test("a project that stalls does not hold the ones behind it closed — and done still waits for it", async () => {
  // 2026-10-05: `arktype` took 88-314s to open on the dev server, and every project after it in the
  // rail — Home included — sat "Not open" for that whole span, where ⌥↑/⌥↓ could not reach it.
  let release!: () => void
  const slow = new Promise<void>((resolve) => (release = resolve))
  const opened: string[] = []
  const { deps, logs } = harness({
    activate: async (p) => {
      if (p.id === "a") await slow
      opened.push(p.id)
      return {}
    },
    stallMs: 20,
  })
  const run = startTenantPrime(deps)
  let settled = false
  void run.done.then(() => (settled = true))
  const deadline = Date.now() + 5_000
  while (opened.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(opened, ["b", "c"], "the projects behind a stalled one never opened")
  assert.ok(logs.some((line) => line.startsWith("a is still opening")), JSON.stringify(logs))
  assert.equal(settled, false, "done resolved with an activation still in flight — shutdown's drain would miss it")
  release()
  const result = await run.done
  assert.deepEqual(result.opened, ["b", "c", "a"])
})

test("stop() during a stall cuts the stall timer short but still waits for the activation", async () => {
  let release!: () => void
  const slow = new Promise<void>((resolve) => (release = resolve))
  const opened: string[] = []
  let run: TenantPrimeRun
  const { deps } = harness({
    activate: async (p) => {
      if (p.id === "a") {
        run.stop()
        setTimeout(release, 30)
        await slow
      }
      opened.push(p.id)
      return {}
    },
    stallMs: 30_000,
  })
  const started = Date.now()
  run = startTenantPrime(deps)
  const result = await run.done
  assert.deepEqual(opened, ["a"])
  assert.deepEqual(result.opened, ["a"])
  assert.ok(Date.now() - started < 5_000, "stop() sat out the stall timer")
})
