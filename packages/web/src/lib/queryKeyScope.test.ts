import assert from "node:assert/strict"
import test from "node:test"
import { QueryClient } from "@tanstack/react-query"
import { projectScopedQueryKeyHash } from "./queryKeyScope.ts"

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
  withPathname("/project/alpha", () => {
    qc.setQueryData(["transcript", "fix-auth"], { messages: ["alpha"] })
    qc.setQueryData(["settingsGet"], { font: "sans" })
  })
  withPathname("/project/beta", () => {
    assert.equal(qc.getQueryData(["transcript", "fix-auth"]), undefined, "beta must not read alpha's thread")
    assert.equal(qc.getQueryData(["settingsGet"]), undefined, "beta must not read alpha's settings")
    qc.setQueryData(["transcript", "fix-auth"], { messages: ["beta"] })
  })
  withPathname("/project/alpha", () => {
    assert.deepEqual(qc.getQueryData(["transcript", "fix-auth"]), { messages: ["alpha"] }, "…and alpha's is still there")
  })
})

test("a late write from the project we left cannot overwrite this project's entry", () => {
  const qc = client()
  // The shape of every in-flight response and every socket frame that outlives a switch: the write is
  // issued with the key it always had, but from a page that has moved on.
  withPathname("/project/alpha", () => qc.setQueryData(["transcript", "fix-auth"], { messages: ["alpha"] }))
  withPathname("/project/beta", () => qc.setQueryData(["transcript", "fix-auth"], { messages: ["beta"] }))
  withPathname("/project/alpha", () => {
    assert.deepEqual(qc.getQueryData(["transcript", "fix-auth"]), { messages: ["alpha"] })
  })
})

test("machine-wide keys stay shared, or the rail refetches itself on every switch", () => {
  const qc = client()
  withPathname("/project/alpha", () => qc.setQueryData(["projectsList"], ["alpha", "beta"]))
  withPathname("/project/beta", () => {
    assert.deepEqual(qc.getQueryData(["projectsList"]), ["alpha", "beta"], "the project list belongs to the machine")
  })
  withPathname("/project/alpha", () => qc.setQueryData(["threadLocate", "fix-auth"], { project: "beta" }))
  withPathname("/project/beta", () => {
    assert.deepEqual(qc.getQueryData(["threadLocate", "fix-auth"]), { project: "beta" }, "threadLocate searches every project by design")
  })
  // The prompt box's model + effort profile is one machine-level record on the server, and the
  // composer writes it optimistically — so the value chosen on alpha is what beta must paint at once.
  withPathname("/project/alpha", () => qc.setQueryData(["dispatchPreferencesGet"], { backend: "claude" }))
  withPathname("/project/beta", () => {
    assert.deepEqual(qc.getQueryData(["dispatchPreferencesGet"]), { backend: "claude" }, "the dispatch profile belongs to the machine")
  })
})

test("a key that carries its project is that project's, whatever page reads it — and never the launcher's", () => {
  const qc = client()
  // The All queues page names no project, so its ambient scope is the LAUNCHING project's. A per-thread
  // read it makes for beta must not land there: the launcher has its own `fix-auth`.
  withPathname("/queues", () => qc.setQueryData(["ofProject", "beta-id", "handoff", "fix-auth"], { text: "beta's" }))
  withPathname("/thread/fix-auth", () => {
    assert.equal(qc.getQueryData(["handoff", "fix-auth"]), undefined, "the launcher's own scope never sees it")
  })
  withPathname("/project/alpha", () => {
    assert.deepEqual(qc.getQueryData(["ofProject", "beta-id", "handoff", "fix-auth"]), { text: "beta's" })
  })
  withPathname("/queues", () => qc.setQueryData(["projectsQueues"], [{ projectId: "beta-id" }]))
  withPathname("/project/beta", () => {
    assert.deepEqual(qc.getQueryData(["projectsQueues"]), [{ projectId: "beta-id" }], "the all-queues read belongs to the machine")
  })
})

test("the unprefixed launching project is a scope of its own, not the absence of one", () => {
  const qc = client()
  // `/thread/x` with no `/project/<slug>` in front of it is a real project — the one the server was
  // launched from — so its entries must not be a free-for-all that any other project can read.
  withPathname("/thread/fix-auth", () => qc.setQueryData(["settingsGet"], { font: "mono" }))
  withPathname("/project/alpha", () => {
    assert.equal(qc.getQueryData(["settingsGet"]), undefined)
  })
  withPathname("/status/active", () => {
    assert.deepEqual(qc.getQueryData(["settingsGet"]), { font: "mono" }, "same launching project, different page")
  })
})
