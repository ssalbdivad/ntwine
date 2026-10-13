import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { createRpcClient } from "./rpc-client.mjs"

test("the verification client addresses the chosen tenant without changing the default route", async () => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push([req.method, req.url])
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(req.url.endsWith("/health") ? { ok: true } : { result: "ok" }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal(await createRpcClient(url).query("board"), "ok")
    const tenant = createRpcClient(url, "second-project")
    assert.equal(await tenant.query("board"), "ok")
    assert.equal(await tenant.mutate("upsertOwnLink", {}), "ok")
    assert.equal(await tenant.waitForHealth(), true)
    assert.deepEqual(seen, [
      ["GET", "/_ntwine/rpc/board"], ["GET", "/_ntwine/second-project/rpc/board"],
      ["POST", "/_ntwine/second-project/rpc/upsertOwnLink"], ["GET", "/_ntwine/second-project/health"],
    ])
  } finally { await new Promise(resolve => server.close(resolve)) }
})
