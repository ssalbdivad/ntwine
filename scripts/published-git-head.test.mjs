import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { test } from "node:test"
import { publishedGitHead } from "./published-git-head.mjs"

const head = "a".repeat(40)
const metadata = { name: "ntwine", version: "0.13.0", gitHead: head }
async function registry(t, handler) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => new Promise((done) => { server.close(done); server.closeAllConnections() }))
  return { registry: `http://127.0.0.1:${server.address().port}/`, intervalMs: 1, timeoutMs: 1000 }
}

test("published gitHead waits for the exact version after a replica 404", async (t) => {
  let requests = 0
  const options = await registry(t, (request, response) => {
    assert.equal(request.url, "/ntwine/0.13.0")
    response.writeHead(++requests === 1 ? 404 : 200)
    response.end(JSON.stringify(metadata))
  })
  assert.equal(await publishedGitHead("ntwine", "0.13.0", options), head)
  assert.equal(requests, 2)
})

test("published gitHead has a bounded wait for absent versions", async (t) => {
  const options = await registry(t, (_, response) => { response.writeHead(404); response.end() })
  await assert.rejects(publishedGitHead("ntwine", "0.13.0", { ...options, timeoutMs: 50 }), /Timed out|TimeoutError/)
})

for (const bad of [{ ...metadata, gitHead: undefined }, { ...metadata, gitHead: "bad" }, { ...metadata, version: "0.12.13" }]) {
  test(`published gitHead refuses invalid metadata ${JSON.stringify(bad)}`, async (t) => {
    const options = await registry(t, (_, response) => response.end(JSON.stringify(bad)))
    await assert.rejects(publishedGitHead("ntwine", "0.13.0", options), /no matching registry gitHead/)
  })
}

test("published gitHead fails closed on authorization errors", async (t) => {
  let requests = 0
  const options = await registry(t, (_, response) => { requests++; response.writeHead(403); response.end() })
  await assert.rejects(publishedGitHead("ntwine", "0.13.0", options), /HTTP 403/)
  assert.equal(requests, 1)
})
