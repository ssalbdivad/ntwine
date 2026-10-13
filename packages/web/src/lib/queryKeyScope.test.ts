import assert from "node:assert/strict"
import test from "node:test"
import { QueryClient } from "@tanstack/react-query"
import { projectQueryKeyHash, projectScopedQueryKeyHash } from "./queryKeyScope.ts"

// These drive a REAL QueryClient rather than comparing hash strings, because the thing under test is
// not the function — it is whether react-query's cache actually treats two projects' entries as
// different ones. `queryKeyHashFn` is what decides cache-entry identity, so a wrong answer here is
// invisible in a unit test of the hash and very visible on screen.

function withPathname<T>(pathname: string, body: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location")
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname } })
  try {
    return body()
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous)
    else Reflect.deleteProperty(globalThis, "location")
  }
}

const client = () => new QueryClient({ defaultOptions: { queries: { queryKeyHashFn: projectScopedQueryKeyHash } } })

test("one project's cache entry is not readable from another project's page", () => {
  const qc = client()
  // `fix-auth` is a perfectly ordinary slug for two projects to share — slugs are unique only within a
  // project — and `settingsGet` genuinely holds different data per project (the server reads a
  // per-project blob). Both are the same bare key on both pages.
  withPathname("/all/alpha/thread/other", () => {
    qc.setQueryData(["transcript", "fix-auth"], { messages: ["alpha"] })
    qc.setQueryData(["settingsGet"], { font: "sans" })
  })
  withPathname("/all/beta/thread/other", () => {
    assert.equal(qc.getQueryData(["transcript", "fix-auth"]), undefined, "beta must not read alpha's thread")
    assert.equal(qc.getQueryData(["settingsGet"]), undefined, "beta must not read alpha's settings")
    qc.setQueryData(["transcript", "fix-auth"], { messages: ["beta"] })
  })
  withPathname("/all/alpha/thread/other", () => {
    assert.deepEqual(qc.getQueryData(["transcript", "fix-auth"]), { messages: ["alpha"] }, "…and alpha's is still there")
  })
})

test("a late write from the project we left cannot overwrite this project's entry", () => {
  const qc = client()
  // The shape of every in-flight response and every socket frame that outlives a switch: the write is
  // issued with the key it always had, but from a page that has moved on.
  withPathname("/all/alpha/thread/other", () => qc.setQueryData(["transcript", "fix-auth"], { messages: ["alpha"] }))
  withPathname("/all/beta/thread/other", () => qc.setQueryData(["transcript", "fix-auth"], { messages: ["beta"] }))
  withPathname("/all/alpha/thread/other", () => {
    assert.deepEqual(qc.getQueryData(["transcript", "fix-auth"]), { messages: ["alpha"] })
  })
})

test("machine-wide keys stay shared, or the rail refetches itself on every switch", () => {
  const qc = client()
  withPathname("/all/alpha/thread/other", () => qc.setQueryData(["projectsList"], ["alpha", "beta"]))
  withPathname("/all/beta/thread/other", () => {
    assert.deepEqual(qc.getQueryData(["projectsList"]), ["alpha", "beta"], "the project list belongs to the machine")
  })
  withPathname("/all/alpha/thread/other", () => qc.setQueryData(["threadLocate", "fix-auth"], { project: "beta" }))
  withPathname("/all/beta/thread/other", () => {
    assert.deepEqual(qc.getQueryData(["threadLocate", "fix-auth"]), { project: "beta" }, "threadLocate searches every project by design")
  })
  // The prompt box's model + effort profile is one machine-level record on the server, and the
  // composer writes it optimistically — so the value chosen on alpha is what beta must paint at once.
  withPathname("/all/alpha/thread/other", () => qc.setQueryData(["dispatchPreferencesGet"], { backend: "claude" }))
  withPathname("/all/beta/thread/other", () => {
    assert.deepEqual(qc.getQueryData(["dispatchPreferencesGet"]), { backend: "claude" }, "the dispatch profile belongs to the machine")
  })
})

test("a key that carries its project is that project's, whatever page reads it — and never the launcher's", () => {
  const qc = client()
  // Everything with no focus names no project, so its ambient scope is the LAUNCHING project's. A per-thread
  // read it makes for beta must not land there: the launcher has its own `fix-auth`.
  withPathname("/", () => qc.setQueryData(["ofProject", "beta-id", "handoff", "fix-auth"], { text: "beta's" }))
  withPathname("/thread/fix-auth", () => {
    assert.equal(qc.getQueryData(["handoff", "fix-auth"]), undefined, "the launcher's own scope never sees it")
  })
  withPathname("/all/alpha/thread/other", () => {
    assert.deepEqual(qc.getQueryData(["ofProject", "beta-id", "handoff", "fix-auth"]), { text: "beta's" })
  })
  withPathname("/", () => qc.setQueryData(["projectsQueues"], [{ projectId: "beta-id" }]))
  withPathname("/all/beta/thread/other", () => {
    assert.deepEqual(qc.getQueryData(["projectsQueues"]), [{ projectId: "beta-id" }], "the all-queues read belongs to the machine")
  })
})

test("the unprefixed launching project is a scope of its own, not the absence of one", () => {
  const qc = client()
  // `/thread/x` with no `/all/<slug>` in front of it is a real project — the one the server was
  // launched from — so its entries must not be a free-for-all that any other project can read.
  withPathname("/thread/fix-auth", () => qc.setQueryData(["settingsGet"], { font: "mono" }))
  withPathname("/all/alpha/thread/other", () => {
    assert.equal(qc.getQueryData(["settingsGet"]), undefined)
  })
  withPathname("/thread/other/full", () => {
    assert.deepEqual(qc.getQueryData(["settingsGet"]), { font: "mono" }, "same launching project, different page")
  })
})

test("a save's machine settings reach every project's cached settings, and nothing else does", async () => {
  const { publishMachineSettings } = await import("../hooks/useSettingsAutosave.tsx")
  const qc = client()
  // Two projects' entries, each holding its own per-project value: a layout hook reads alpha's (it was
  // cold-loaded there), and the settings drawer saves under beta's (the page was switched to beta).
  const base = { permissionMode: "bypassPermissions", projectRail: false, notifications: true, localFileOpener: "system" }
  withPathname("/all/alpha/thread/x", () => qc.setQueryData(["settingsGet"], { ...base, permissionMode: "auto" }))
  const saved = { ...base, projectRail: true, notifications: false, localFileOpener: "cursor" }
  withPathname("/all/beta/thread/x", () => {
    qc.setQueryData(["settingsGet"], saved)
    publishMachineSettings(qc, saved as never)
  })
  const alpha = withPathname("/all/alpha/thread/x", () => qc.getQueryData<typeof base>(["settingsGet"]))
  assert.equal(alpha?.projectRail, true, "the rail's toggle reaches the entry the layout's rail reads (lib/projectRail.ts)")
  assert.equal(alpha?.notifications, false, "the machine's notifications reach the other project's entry")
  assert.equal(alpha?.localFileOpener, "cursor", "…and so does every other machine key")
  assert.equal(alpha?.permissionMode, "auto", "a project's own setting is left where it was")
  const beta = withPathname("/all/beta/thread/x", () => qc.getQueryData<typeof base>(["settingsGet"]))
  assert.equal(beta?.permissionMode, "bypassPermissions", "the saving project's own entry is the save")
})

test("an entry written for a project by name is the one that project's page reads", async () => {
  // hooks.ts prefetchProjectTranscript writes another project's transcript at the click, while the page is
  // still bound to the project being left; the drawer reads it once the page has moved.
  const qc = client()
  await withPathname("/all/ntwine", () =>
    qc.prefetchQuery({ queryKey: ["transcript", "fix-auth"], queryKeyHashFn: (key) => projectQueryKeyHash("home", key), queryFn: () => ({ messages: ["prefetched"] }) }))
  withPathname("/all/home/thread/fix-auth", () => {
    assert.deepEqual(qc.getQueryData(["transcript", "fix-auth"]), { messages: ["prefetched"] })
  })
  withPathname("/all/ntwine/thread/fix-auth", () => {
    assert.equal(qc.getQueryData(["transcript", "fix-auth"]), undefined, "and only that project's page")
  })
  assert.equal(projectQueryKeyHash("home", ["projectsQueues"]), projectQueryKeyHash("ntwine", ["projectsQueues"]), "machine-wide keys stay shared")
})
