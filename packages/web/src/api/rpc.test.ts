import { test } from "node:test"
import assert from "node:assert/strict"
import { assertMutationAllowedDuringControlPlaneTransition, CONTROL_PLANE_RESTARTING_MESSAGE, isKeptDeliveryError, isRetryableRpcError, parseRpcResponse, routeCall } from "./rpc.ts"
import { setHomeFocus } from "../lib/base-path.ts"
import { store } from "../store.ts"

test("RPC response: a stale server's plain-text missing route asks for a server restart", async () => {
  await assert.rejects(
    parseRpcResponse(new Response("404 Not Found", { status: 404 }), "setThreadPermission"),
    /ntwine server restart required/,
  )
})

test("RPC transition guard holds writes locally while preserving query access", () => {
  const previous = store.controlPlaneState
  try {
    store.controlPlaneState = "restarting"
    assert.throws(
      () => assertMutationAllowedDuringControlPlaneTransition("mutation"),
      new RegExp(CONTROL_PLANE_RESTARTING_MESSAGE),
    )
    assert.doesNotThrow(() => assertMutationAllowedDuringControlPlaneTransition("query"))
  } finally {
    store.controlPlaneState = previous
  }
})

test("RPC response: valid server errors and successful envelopes keep their normal semantics", async () => {
  await assert.rejects(
    parseRpcResponse(new Response(JSON.stringify({ error: "specific failure" }), { status: 500 }), "x"),
    /specific failure/,
  )
  assert.deepEqual(
    await parseRpcResponse(new Response(JSON.stringify({ result: { effect: "next-resume" } }), { status: 200 }), "x"),
    { effect: "next-resume" },
  )
})

// `kept`: the server holds a failed follow-up as a failed bubble (server/src/router.ts
// keepFailedFollowUp). It rides beside `retryable`, and neither implies the other.
test("a kept follow-up failure is readable on the thrown error", async () => {
  const kept = await parseRpcResponse(new Response(JSON.stringify({ error: "cold resume failed", kept: true }), { status: 500 }), "followUp").then(() => null, (e: unknown) => e)
  assert.equal(isKeptDeliveryError(kept), true)
  assert.equal(isRetryableRpcError(kept), false)
  assert.equal((kept as Error).message, "cold resume failed")
  const plain = await parseRpcResponse(new Response(JSON.stringify({ error: "stale tab" }), { status: 500 }), "followUp").then(() => null, (e: unknown) => e)
  assert.equal(isKeptDeliveryError(plain), false)
})

// ── A PAGE WITH NO PROJECT BOUND REFUSES A CALL THAT NEEDS ONE (routeCall) ─────────────────────────
// `/all` and `/` name no project in their path; the route binds the pick (setHomeFocus). Before it does,
// or with nothing to pick, `apiBase()` there is the LAUNCHING project's `/_ntwine` — so a forgotten project
// used to read or write a stranger's state and look fine. Upstream 759c3255's guard, in the fork's terms.

test("an unbound All projects page refuses a thread or project call rather than send it to the launching project", () => {
  for (const page of ["/all", "/all/", "/"]) {
    assert.throws(() => routeCall("threadTranscript", { slug: "fix-auth" }, page), /names no project/, page)
    assert.throws(() => routeCall("dispatch", { prompt: "x" }, page), /needs a project/, page)
    // Machine-wide calls still go, including threadLocate's REAL slug, which searches every project.
    assert.equal(routeCall("projectsList", undefined, page), "/_ntwine", page)
    assert.equal(routeCall("threadLocate", { slug: "fix" }, page), "/_ntwine", page)
  }
})

test("a bound page, a board and the launching project's own page route as they always did", () => {
  try {
    setHomeFocus("nub")
    assert.equal(routeCall("dispatch", { prompt: "x" }, "/all"), "/_ntwine/nub")
    assert.equal(routeCall("threadTranscript", { slug: "fix" }, "/"), "/_ntwine/nub")
  } finally {
    setHomeFocus(undefined)
  }
  assert.equal(routeCall("threadTranscript", { slug: "fix" }, "/project/nub/thread/fix"), "/_ntwine/nub")
  assert.equal(routeCall("threadTranscript", { slug: "fix" }, "/all/nub/thread/fix"), "/_ntwine/nub")
  // The unprefixed /full IS the launching project's page, so `/_ntwine` there is meant.
  assert.equal(routeCall("threadTranscript", { slug: "fix" }, "/thread/fix/full"), "/_ntwine")
})

test("a refused call is a rejected promise that never reaches the wire", async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
  const previousFetch = globalThis.fetch
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname: "/all", origin: "http://ntwine.test" } })
  const sent: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    sent.push(String(url))
    return new Response(JSON.stringify({ result: [] }), { status: 200 })
  }) as typeof fetch
  try {
    const { rpc } = await import("./rpc.ts")
    const refused = rpc.dispatch({ prompt: "x" } as never)
    assert.ok(refused instanceof Promise, "a refusal is not a synchronous throw")
    await assert.rejects(refused, /needs a project/)
    assert.deepEqual(sent, [])
    // The negative control: a machine-wide call from the same page is sent.
    await rpc.projectsList()
    assert.deepEqual(sent, ["http://ntwine.test/_ntwine/rpc/projectsList"])
  } finally {
    globalThis.fetch = previousFetch
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation)
    else Reflect.deleteProperty(globalThis, "location")
  }
})
