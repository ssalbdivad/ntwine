import { cpSync, existsSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { assertWorkerPluginClosure } from "../src/worker-plugin-closure.ts"

// Stage static server assets in the separately published `ntwine-server` package. The root `ntwine`
// package is deliberately only a stable launcher: its prepack invokes this script so a subsequent
// `npm pack --ignore-scripts packages/server-release` sees a complete server tarball too. Do not
// clean this staging in root postpack; release packs the server first, then the shell, and local
// artifact tests intentionally pack both from this one build.
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "..")
const serverRelease = resolve(repo, "packages/server-release")
const webTarget = resolve(serverRelease, "web-dist")
const runtime = resolve(serverRelease, "runtime")

if (process.argv[2] !== "--server") {
  throw new Error("usage: prepare-package.mjs --server")
}

const webDist = resolve(repo, "packages/web/dist")
execFileSync("pnpm", ["--dir", repo, "--filter", "@ntwine/web", "build"], { stdio: "pipe" })
if (!existsSync(webDist)) throw new Error("Ntwine web build did not produce packages/web/dist")
rmSync(webTarget, { recursive: true, force: true })
cpSync(webDist, webTarget, { recursive: true })

const skip = (src) => {
  const base = src.split("/").pop() ?? ""
  return base === "node_modules" || base.endsWith(".test.mjs")
}
rmSync(runtime, { recursive: true, force: true })
const stage = (from, to, label) => {
  if (!existsSync(from)) throw new Error(`Ntwine runtime closure source is missing: ${label} (${from})`)
  cpSync(from, to, { recursive: true, filter: (s) => !skip(s) })
}
stage(resolve(repo, "board"), resolve(runtime, "board"), "board")
stage(resolve(repo, "cc-worker"), resolve(runtime, "cc-worker"), "cc-worker")
assertWorkerPluginClosure(runtime)
console.log("ntwine-server staging: built web-dist and runtime closure")
