#!/usr/bin/env node
// Tag a published `frizz` shell and create its GitHub release — the releaser's last step, run from
// its own `gh` session once release.yml is green (AGENTS.md § Cutting a release).
//
//   nub scripts/tag-release.mjs            the version in the root package.json
//   nub scripts/tag-release.mjs 0.13.13    a named version
//
// WHY THIS IS NOT IN THE WORKFLOW (maintainer 2026-10-12). release.yml tagged the shell itself until
// GitHub refused it: a workflow's own token may not create a ref whose commit carries a different
// `.github/workflows/` than the run's checkout, and the shell is tagged at npm's recorded gitHead,
// which a later run routinely is not (frizz 0.13.13, tagged by a run whose own commit had changed
// release.yml). The releaser's `gh` session holds the workflow scope, so the tag is made here instead,
// and the workflow keeps no write access to the repository at all.
//
// The target is npm's recorded gitHead, never a local checkout, and an existing tag is never moved:
// a re-run reports what is already there and creates only what is missing.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { publishedGitHead } from "./published-git-head.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const version = process.argv[2] ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`)
const tag = `v${version}`

const gh = (args, input) => execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim()
const ghOk = (args) => { try { gh(args); return true } catch { return false } }

const repo = process.env.FRIZZ_RELEASE_REPO ?? gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
// Fails closed: no served version, or one with no gitHead, is never tagged.
const gitHead = await publishedGitHead("frizz", version, { registry: process.env.FRIZZ_NPM_REGISTRY, timeoutMs: 30_000 })

let existing
try { existing = gh(["api", `repos/${repo}/git/ref/tags/${tag}`, "--jq", ".object.sha + \" \" + .object.type"]) } catch { existing = undefined }
if (existing) {
  const [sha, type] = existing.split(" ")
  const target = type === "tag" ? gh(["api", `repos/${repo}/git/tags/${sha}`, "--jq", ".object.sha"]) : sha
  if (target !== gitHead) throw new Error(`${tag} already points at ${target}, not npm's ${gitHead}; it is never moved`)
  console.log(`${tag} is already tagged at ${gitHead}`)
} else {
  const object = gh(["api", "-X", "POST", `repos/${repo}/git/tags`, "--input", "-", "--jq", ".sha"],
    JSON.stringify({ tag, message: `frizz ${tag}`, object: gitHead, type: "commit" }))
  gh(["api", "-X", "POST", `repos/${repo}/git/refs`, "--input", "-", "--jq", ".ref"],
    JSON.stringify({ ref: `refs/tags/${tag}`, sha: object }))
  console.log(`tagged ${tag} at ${gitHead}`)
}

if (ghOk(["release", "view", tag, "--repo", repo])) {
  console.log(`the ${tag} release already exists`)
} else {
  gh(["release", "create", tag, "--repo", repo, "--title", `frizz ${tag}`,
    "--notes", `Published to npm: https://www.npmjs.com/package/frizz/v/${version}`, "--verify-tag"])
  console.log(`created the ${tag} GitHub release`)
}
