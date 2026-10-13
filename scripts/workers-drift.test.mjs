import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { test } from "node:test"
import { ACCOUNT_ID, checkWorker, cloudflareClient, githubClient, parseCiMessage } from "./workers-drift.mjs"

// The bodies below follow the shapes Cloudflare documents for
//   GET /accounts/{account_id}/workers/scripts/{script}/deployments
//   GET /accounts/{account_id}/workers/scripts/{script}/versions[/{version_id}]
// and GitHub's GET /repos/{owner}/{repo}/actions/runs/{run_id}, cut down to the fields the check
// reads. They are NOT captured from the live account: nothing that wrote this held a read token. The
// first scheduled run is the one that meets the real API, and it fails loudly on any shape it
// cannot read rather than passing.

const REPO = "colinhacks/frizz"
const SHA = "6b6436701f2a3c4d5e6f708192a3b4c5d6e7f809"
const RUN = "18123456789"
const CI_AUTHOR = "4f1c2b3a9d8e7f60a1b2c3d4e5f60718"
const NOW = Date.parse("2026-10-09T12:00:00Z")
const base = `/accounts/${ACCOUNT_ID}/workers/scripts/ntwine-relay`

const ciVersion = (id, created_on, overrides = {}) => ({
  id,
  number: 41,
  metadata: { author_id: CI_AUTHOR, author_email: "", created_on, modified_on: created_on, source: "wrangler", hasPreview: false },
  annotations: { "workers/message": `ci:${SHA} run:${RUN}`, "workers/triggered_by": "upload" },
  ...overrides,
})
const deployment = (id, created_on, versionIds, message = `ci:${SHA} run:${RUN}`, author_email = "") => ({
  id,
  created_on,
  source: "wrangler",
  strategy: "percentage",
  author_email,
  annotations: { "workers/message": message, "workers/triggered_by": "upload" },
  versions: versionIds.map((version_id) => ({ version_id, percentage: 100 / versionIds.length })),
})
const run = (overrides = {}) => ({
  id: Number(RUN),
  path: ".github/workflows/workers-deploy.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
  created_at: "2026-10-09T09:00:00Z",
  updated_at: "2026-10-09T09:04:00Z",
  ...overrides,
})

/** Fake `cf` and `gh` over fixed bodies; a path nobody recorded is a test bug, so it throws. */
function apis({ deployments, versions, runs = { [RUN]: run() } }) {
  const requested = []
  const cf = async (path) => {
    requested.push(path)
    if (path === `${base}/deployments`) return { deployments }
    const page = /\/versions\?page=(\d+)&per_page=50$/.exec(path)
    if (page) return { items: Number(page[1]) === 1 ? versions.map(({ annotations, ...item }) => item) : [] }
    const one = /\/versions\/([^/?]+)$/.exec(path)
    if (one) {
      const found = versions.find((v) => v.id === one[1])
      if (found) return found
    }
    throw new Error(`unrecorded Cloudflare path ${path}`)
  }
  const gh = async (path) => {
    const match = new RegExp(`^/repos/${REPO}/actions/runs/(\\d+)$`).exec(path)
    if (!match) throw new Error(`unrecorded GitHub path ${path}`)
    return runs[match[1]] ?? null
  }
  return { cf, gh, requested }
}

const check = (fixture, options = {}) => {
  const { cf, gh } = apis(fixture)
  return checkWorker("ntwine-relay", { cf, gh, repo: REPO, expectedAuthor: CI_AUTHOR, now: NOW, ...options })
}

const v1 = "11111111-1111-4111-8111-111111111111"
const v2 = "22222222-2222-4222-8222-222222222222"
const d1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const d2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

test("a CI message parses to its sha and run, and nothing else does", () => {
  assert.deepEqual(parseCiMessage(`ci:${SHA} run:${RUN}`), { sha: SHA, runId: RUN })
  for (const bad of [undefined, "", "Automatic deployment on upload.", `ci:${SHA.slice(0, 7)} run:${RUN}`, `ci:${SHA} run:${RUN} extra`, ` ci:${SHA} run:${RUN}`]) {
    assert.equal(parseCiMessage(bad), null, JSON.stringify(bad))
  }
})

test("a Worker running only what CI uploaded passes", async () => {
  const problems = await check({
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z")],
  })
  assert.deepEqual(problems, [])
})

test("a deploy from a laptop fails on its message and on its author", async () => {
  const laptop = ciVersion(v2, "2026-10-09T11:00:00Z", {
    metadata: { author_id: "e0c1d2b3a4f5", author_email: "someone@example.com", created_on: "2026-10-09T11:00:00Z", source: "wrangler" },
    annotations: { "workers/triggered_by": "upload" },
  })
  const problems = await check({
    deployments: [deployment(d2, "2026-10-09T11:00:02Z", [v2], "", "someone@example.com"), deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z"), laptop],
  })
  assert.ok(problems.some((p) => p.includes(`deployment ${d2} (active`) && p.includes("is not a CI deploy's")), problems.join("\n"))
  assert.ok(problems.some((p) => p.includes(`version ${v2}`) && p.includes("someone@example.com") && p.includes(CI_AUTHOR)), problems.join("\n"))
})

test("a forged CI message is caught by the run: replayed outside its window, wrong workflow, wrong sha, no such run", async () => {
  const forged = (runs, created = "2026-10-09T11:30:00Z") => check({
    deployments: [deployment(d1, created, [v1])],
    versions: [ciVersion(v1, created)],
    runs,
  })
  const replayed = await forged({ [RUN]: run() })
  assert.ok(replayed.some((p) => p.includes(`deployment ${d1}`) && p.includes("a replayed message")), replayed.join("\n"))
  assert.ok(replayed.some((p) => p.includes(`version ${v1}`) && p.includes("a replayed message")), replayed.join("\n"))

  const otherWorkflow = await forged({ [RUN]: run({ path: ".github/workflows/release.yml", updated_at: "2026-10-09T11:59:00Z" }) })
  assert.ok(otherWorkflow.some((p) => p.includes(".github/workflows/release.yml, not .github/workflows/workers-deploy.yml")), otherWorkflow.join("\n"))

  const otherSha = await forged({ [RUN]: run({ head_sha: "f".repeat(40), updated_at: "2026-10-09T11:59:00Z" }) })
  assert.ok(otherSha.some((p) => p.includes(`run ${RUN} ran ${"f".repeat(40)}`)), otherSha.join("\n"))

  const otherBranch = await forged({ [RUN]: run({ head_branch: "workers-deploy-ci", updated_at: "2026-10-09T11:59:00Z" }) })
  assert.ok(otherBranch.some((p) => p.includes("ran on workers-deploy-ci, not main")), otherBranch.join("\n"))

  const pushed = await forged({ [RUN]: run({ event: "push", updated_at: "2026-10-09T11:59:00Z" }) })
  assert.ok(pushed.some((p) => p.includes("started by push, not a dispatch")), pushed.join("\n"))

  const missing = await forged({})
  assert.ok(missing.some((p) => p.includes(`run ${RUN}, which does not exist in ${REPO}`)), missing.join("\n"))
})

test("a run still in progress counts up to now, and a workflow path carrying a ref still matches", async () => {
  const problems = await check({
    deployments: [deployment(d1, "2026-10-09T11:58:00Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T11:57:50Z")],
    runs: { [RUN]: run({ status: "in_progress", conclusion: null, created_at: "2026-10-09T11:55:00Z", updated_at: "2026-10-09T11:55:30Z", path: ".github/workflows/workers-deploy.yml@refs/heads/main" }) },
  })
  assert.deepEqual(problems, [])
})

test("a stray deploy that was rolled back still fails while it is inside the lookback, and stops once it is not", async () => {
  const stray = ciVersion(v2, "2026-10-09T11:10:00Z", {
    metadata: { author_id: "e0c1d2b3a4f5", author_email: "someone@example.com", created_on: "2026-10-09T11:10:00Z", source: "api" },
    annotations: {},
  })
  const fixture = {
    deployments: [
      deployment(d1, "2026-10-09T11:20:00Z", [v1], "Rollback to CI", ""),
      deployment(d2, "2026-10-09T11:10:05Z", [v2], "", "someone@example.com"),
    ],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z"), stray],
  }
  const recent = await check(fixture)
  assert.ok(recent.some((p) => p.includes(`deployment ${d2} (recent`)), recent.join("\n"))
  assert.ok(recent.some((p) => p.includes(`version ${v2}`) && p.includes("uploaded from api, not wrangler")), recent.join("\n"))
  // The rollback itself is a deployment CI did not make, even though the version it points at is CI's.
  assert.ok(recent.some((p) => p.includes(`deployment ${d1} (active`)), recent.join("\n"))
  assert.ok(!recent.some((p) => p.includes(`version ${v1}`)), recent.join("\n"))

  const later = await check(fixture, { now: Date.parse("2026-10-09T14:00:00Z") })
  assert.ok(!later.some((p) => p.includes(d2) || p.includes(v2)), later.join("\n"))
})

test("an upload that was never deployed is an alarm too", async () => {
  const problems = await check({
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z"), ciVersion(v2, "2026-10-09T11:40:00Z", { annotations: { "workers/message": "test" } })],
  })
  assert.deepEqual(problems.length, 1, problems.join("\n"))
  assert.match(problems[0], new RegExp(`version ${v2} \\(uploaded recently`))
})

test("both versions of a split deployment are checked", async () => {
  const other = ciVersion(v2, "2026-10-09T08:00:00Z", { annotations: {} })
  const problems = await check({
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1, v2])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z"), other],
  })
  assert.ok(problems.some((p) => p.includes(`version ${v2} (in the active deployment`)), problems.join("\n"))
})

test("with WORKERS_CI_AUTHOR unset it fails, and says which author it saw", async () => {
  const problems = await check({
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z")],
  }, { expectedAuthor: undefined })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /WORKERS_CI_AUTHOR is not set/)
  assert.ok(problems[0].includes(CI_AUTHOR))
})

test("an author email matches as well as an author id", async () => {
  const problems = await check({
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z", { metadata: { author_id: "x", author_email: "ci@example.com", created_on: "2026-10-09T09:03:05Z", source: "wrangler" } })],
  }, { expectedAuthor: "ci@example.com" })
  assert.deepEqual(problems, [])
})

test("a Worker with no deployments at all is a finding", async () => {
  const problems = await check({ deployments: [], versions: [] })
  assert.deepEqual(problems, ["ntwine-relay: Cloudflare lists no deployments at all"])
})

async function server(t, handler) {
  const s = createServer(handler)
  s.listen(0, "127.0.0.1")
  await once(s, "listening")
  t.after(() => new Promise((done) => { s.close(done); s.closeAllConnections() }))
  return `http://127.0.0.1:${s.address().port}`
}

test("the Cloudflare client sends the token, unwraps result, and throws on any failure", async (t) => {
  const seen = []
  const url = await server(t, (request, response) => {
    seen.push([request.url, request.headers.authorization])
    if (request.url === "/ok") return response.end(JSON.stringify({ success: true, errors: [], messages: [], result: { deployments: [] } }))
    if (request.url === "/denied") {
      response.writeHead(403)
      return response.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null }))
    }
    response.end(JSON.stringify({ success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }], messages: [], result: null }))
  })
  const cf = cloudflareClient("read-token", { base: url })
  assert.deepEqual(await cf("/ok"), { deployments: [] })
  await assert.rejects(cf("/denied"), /HTTP 403 \(10000: Authentication error\)/)
  await assert.rejects(cf("/unsuccessful"), /HTTP 200 \(10007: This Worker does not exist/)
  assert.deepEqual(seen.map(([, auth]) => auth), ["Bearer read-token", "Bearer read-token", "Bearer read-token"])
})

test("the GitHub client returns null for a missing run and throws on anything else", async (t) => {
  const url = await server(t, (request, response) => {
    if (request.url.endsWith("/1")) return response.end(JSON.stringify(run()))
    response.writeHead(request.url.endsWith("/2") ? 404 : 500)
    response.end("{}")
  })
  const gh = githubClient("gh-token", { base: url })
  assert.equal((await gh(`/repos/${REPO}/actions/runs/1`)).head_sha, SHA)
  assert.equal(await gh(`/repos/${REPO}/actions/runs/2`), null)
  await assert.rejects(gh(`/repos/${REPO}/actions/runs/3`), /HTTP 500/)
})
