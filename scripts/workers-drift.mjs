// Fails when the frizz.sh Workers run anything that `.github/workflows/workers-deploy.yml` did not
// upload. `.github/workflows/workers-drift.yml` runs it every 30 minutes, and a failed scheduled run
// is the alarm: GitHub emails it.
//
// WHY IT EXISTS. From 2026-09-21 to 2026-10-08 an attacker holding a Cloudflare API token replaced
// both Workers with backdoored builds of our own source, and nothing noticed for seventeen days. The
// Workers now deploy from CI only, so every upload that did not come from CI is by definition wrong,
// and this is the check that says so.
//
// WHAT COUNTS AS CI. Each check below is one an attacker holding a Cloudflare deploy token must pass:
//
// - The message. CI deploys with `--message "ci:<sha> run:<run id>"`, which wrangler stamps on the
//   version AND the deployment. Anyone with a token can type that, so on its own it proves nothing;
//   what it buys is the run id for the next check.
// - The run. The named run must exist in THIS repository, be a `workflow_dispatch` of
//   workers-deploy.yml on main at the named sha, and the upload must have happened while that run was
//   live. A Cloudflare token cannot create a GitHub run, and an old run's window has closed, so a
//   replayed message lands outside it. This is the check that holds.
// - The author. Every version records who uploaded it. CI uploads with an account-owned token that
//   nothing else holds, so its author differs from any laptop's; `WORKERS_CI_AUTHOR` (a repository
//   variable) names it. Unset, the check fails and prints the authors it saw, so the first CI deploy
//   tells you the value.
// - The source. `metadata.source` must be `wrangler`. Weak — an attacker uses wrangler too — but a
//   dashboard edit or a raw API upload fails it for free.
//
// WHAT IT READS. The ACTIVE deployment always (the newest; it serves 100% of traffic unless a split
// names two versions, and then both are checked), plus every deployment and every version created in
// the last LOOKBACK. The lookback is what catches an attacker who deploys and rolls back between two
// runs, and an upload that was never deployed. It is wider than the schedule because GitHub delays
// and drops scheduled runs under load.
//
// A legitimate `wrangler secret put` or dashboard edit fails this too: each one creates a version and
// a deployment that CI did not make, and nothing here can tell the maintainer from an attacker. That
// is the point. Re-run the deploy workflow afterwards; the alarm clears once the CI deployment is
// active and the stray one has aged out of the lookback.
//
// Anything it cannot read — a missing or revoked token, a Cloudflare or GitHub error — also fails the
// run. A check that cannot see must not go green.
//
//   CLOUDFLARE_READ_TOKEN=… GITHUB_TOKEN=… GITHUB_REPOSITORY=colinhacks/frizz \
//     WORKERS_CI_AUTHOR=… node scripts/workers-drift.mjs [ntwine-relay] [ntwine-registrar]

import { pathToFileURL } from "node:url"

export const ACCOUNT_ID = "dde3ec1f6b1f0a397ea82a9ed322f5ce"
export const WORKERS = ["ntwine-relay", "ntwine-registrar"]
export const DEPLOY_WORKFLOW = ".github/workflows/workers-deploy.yml"
export const LOOKBACK_MS = 2 * 60 * 60 * 1000
// Cloudflare's and GitHub's clocks, and the gap between the run starting and wrangler's first call.
const SKEW_MS = 2 * 60 * 1000
const CI_MESSAGE = /^ci:([0-9a-f]{40}) run:(\d+)$/

/** The sha and run id a CI deploy stamps, or null for any other message. */
export function parseCiMessage(message) {
  const match = CI_MESSAGE.exec(message ?? "")
  return match ? { sha: match[1], runId: match[2] } : null
}

/** GET a Cloudflare API path and unwrap `result`; throws on any error, so the run fails. */
export function cloudflareClient(token, { base = "https://api.cloudflare.com/client/v4" } = {}) {
  return async (path) => {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.success) {
      const errors = (body?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ")
      throw new Error(`Cloudflare ${path}: HTTP ${response.status}${errors ? ` (${errors})` : ""}`)
    }
    return body.result
  }
}

/** GET a GitHub API path; null on 404 (a run that does not exist is a finding, not an error). */
export function githubClient(token, { base = "https://api.github.com" } = {}) {
  return async (path) => {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    })
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`)
    return response.json()
  }
}

/**
 * Every problem with one Worker, as sentences; an empty list means everything it runs came from CI.
 * `cf` and `gh` take an API path and return the parsed body (see the two clients above).
 */
export async function checkWorker(script, { cf, gh, repo, expectedAuthor, now = Date.now(), lookbackMs = LOOKBACK_MS, log = () => {} }) {
  const problems = []
  const runs = new Map()
  const since = now - lookbackMs
  const base = `/accounts/${ACCOUNT_ID}/workers/scripts/${script}`

  const runFor = async (runId) => {
    if (!runs.has(runId)) runs.set(runId, gh(`/repos/${repo}/actions/runs/${runId}`))
    return runs.get(runId)
  }

  // Why `message` stamped at `createdOn` is not a CI upload, or null when it is.
  const notFromCi = async (message, createdOn) => {
    const ci = parseCiMessage(message)
    if (!ci) return `its message ${JSON.stringify(message ?? "")} is not a CI deploy's`
    const run = await runFor(ci.runId)
    if (!run) return `it names run ${ci.runId}, which does not exist in ${repo}`
    const path = String(run.path ?? "").split("@")[0]
    if (path !== DEPLOY_WORKFLOW) return `it names run ${ci.runId}, which is ${path || "an unknown workflow"}, not ${DEPLOY_WORKFLOW}`
    if (run.event !== "workflow_dispatch") return `it names run ${ci.runId}, which was started by ${run.event}, not a dispatch`
    if (run.head_branch !== "main") return `it names run ${ci.runId}, which ran on ${run.head_branch}, not main`
    if (run.head_sha !== ci.sha) return `it names ${ci.sha} but run ${ci.runId} ran ${run.head_sha}`
    const at = Date.parse(createdOn)
    const opened = Date.parse(run.created_at) - SKEW_MS
    const closed = (run.status === "completed" ? Date.parse(run.updated_at) : now) + SKEW_MS
    if (!(at >= opened && at <= closed)) {
      return `it was created at ${createdOn}, outside run ${ci.runId} (${run.created_at} to ${run.status === "completed" ? run.updated_at : "now"}) — a replayed message`
    }
    return null
  }

  const checkedVersions = new Set()
  const checkVersion = async (id, why) => {
    if (checkedVersions.has(id)) return
    checkedVersions.add(id)
    const version = await cf(`${base}/versions/${id}`)
    const meta = version.metadata ?? {}
    const message = version.annotations?.["workers/message"]
    log(`  version ${id} (${why}): created ${meta.created_on}, source ${meta.source}, author_id ${meta.author_id ?? "-"}, author_email ${meta.author_email ?? "-"}, message ${JSON.stringify(message ?? "")}`)
    const label = `${script} version ${id} (${why}, created ${meta.created_on})`
    const reason = await notFromCi(message, meta.created_on)
    if (reason) problems.push(`${label}: ${reason}`)
    if (meta.source !== "wrangler") problems.push(`${label}: uploaded from ${meta.source ?? "an unknown source"}, not wrangler`)
    if (!expectedAuthor) {
      problems.push(`${label}: WORKERS_CI_AUTHOR is not set, so its author (author_id ${meta.author_id ?? "-"}, author_email ${meta.author_email ?? "-"}) cannot be checked`)
    } else if (meta.author_id !== expectedAuthor && meta.author_email !== expectedAuthor) {
      problems.push(`${label}: uploaded by author_id ${meta.author_id ?? "-"} / author_email ${meta.author_email ?? "-"}, not the CI token's ${expectedAuthor}`)
    }
  }

  const { deployments = [] } = await cf(`${base}/deployments`)
  const newestFirst = [...deployments].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))
  if (newestFirst.length === 0) problems.push(`${script}: Cloudflare lists no deployments at all`)
  for (const [index, deployment] of newestFirst.entries()) {
    const active = index === 0
    if (!active && Date.parse(deployment.created_on) < since) continue
    const why = active ? "active" : "recent"
    const message = deployment.annotations?.["workers/message"]
    log(`${script} deployment ${deployment.id} (${why}): created ${deployment.created_on}, author ${deployment.author_email ?? "-"}, message ${JSON.stringify(message ?? "")}`)
    const reason = await notFromCi(message, deployment.created_on)
    if (reason) problems.push(`${script} deployment ${deployment.id} (${why}, created ${deployment.created_on}): ${reason}`)
    for (const { version_id: id } of deployment.versions ?? []) await checkVersion(id, `in the ${why} deployment`)
  }

  // An upload that was never deployed serves nothing on frizz.sh, but it is still an upload CI did
  // not make — and the step before a deploy.
  for (let page = 1; page <= 20; page++) {
    const { items = [] } = await cf(`${base}/versions?page=${page}&per_page=50`)
    for (const item of items) {
      if (Date.parse(item.metadata?.created_on) >= since) await checkVersion(item.id, "uploaded recently")
    }
    if (items.length < 50) break
  }

  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { CLOUDFLARE_READ_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY, WORKERS_CI_AUTHOR } = process.env
  for (const [name, value] of Object.entries({ CLOUDFLARE_READ_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY })) {
    if (!value) {
      console.error(`::error::${name} is not set; the drift check cannot read anything, so it fails`)
      process.exit(1)
    }
  }
  const scripts = process.argv.slice(2).length ? process.argv.slice(2) : WORKERS
  const cf = cloudflareClient(CLOUDFLARE_READ_TOKEN)
  const gh = githubClient(GITHUB_TOKEN)
  let failed = false
  for (const script of scripts) {
    try {
      const problems = await checkWorker(script, { cf, gh, repo: GITHUB_REPOSITORY, expectedAuthor: WORKERS_CI_AUTHOR, log: console.log })
      if (problems.length === 0) console.log(`✓ ${script}: everything it ran in the lookback came from ${DEPLOY_WORKFLOW}`)
      for (const problem of problems) console.error(`::error::${problem}`)
      failed ||= problems.length > 0
    } catch (error) {
      console.error(`::error::${script}: ${error.message}`)
      failed = true
    }
  }
  process.exit(failed ? 1 : 0)
}
