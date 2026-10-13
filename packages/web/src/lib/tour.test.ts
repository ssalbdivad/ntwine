import assert from "node:assert/strict"
import { test } from "node:test"

// The first-run decision is read once, at module load, so each case loads a fresh copy of the module over
// its own storage.
function storage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries))
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
  return map
}

let fresh = 0
const load = () => import(`./tour.ts?case=${fresh++}`) as Promise<typeof import("./tour.ts")>

test("a new browser starts the tour, and ending it is remembered", async () => {
  const map = storage({})
  const tour = await load()
  assert.equal(tour.hasOnboarded(), false)
  tour.startTourOnFirstRun()
  tour.setTourStep(2)
  tour.endTour()
  assert.equal(tour.hasOnboarded(), true)
  assert.equal(map.get("ntwine.onboarded"), "1")
  const again = await load()
  assert.equal(again.hasOnboarded(), true, "the next page load does not start it again")
})

test("a browser that already showed a view, from before the onboarding, still gets it once", async () => {
  const map = storage({ "ntwine.lastView": "all" })
  const tour = await load()
  assert.equal(tour.hasOnboarded(), false)
  tour.endTour()
  assert.equal(map.get("ntwine.onboarded"), "1")
})

test("with storage unavailable nothing could remember the tour, so it never starts on its own", async () => {
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error("denied")
    },
  }
  const tour = await load()
  assert.equal(tour.hasOnboarded(), true)
})
