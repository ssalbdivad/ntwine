// Bundle the extension into dist/extension.cjs, which (with the manifest, README, LICENSE, icon and the
// build's record, dist/build.json) is all the .vsix ships. CommonJS because VS Code's extension host
// loads `main` with require(). `ws`'s optional native accelerators stay external — it falls back to pure
// JS when they are absent, which in an editor they always are. `vscode` is provided by the host at
// runtime.
//
//   node scripts/build.ts          the extension
//   node scripts/build.ts --e2e    also the end-to-end suite (dist/e2e/suite.cjs) and the real-page sidebar
//                                 run's editor half (dist/e2e/sidebar-agent.cjs), never packaged

import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build, type BuildOptions } from "esbuild"
import { BUILD_FILE, buildLabel, type BuildInfo } from "../src/build-info.ts"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(pkg, "dist")
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// WHICH BUILD THIS IS (src/build-info.ts): the version, the commit, whether the bundle's own sources had
// uncommitted changes, when, and an id of its own — compiled into the bundle and written beside it, so a
// window can say what it runs and notice when a different build is installed under it. "Dirty" looks at
// what the bundle is made of (this package and packages/shared), not the whole checkout: a draft in the
// web package changes nothing a window runs.
function git(...args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: pkg, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return undefined
  }
}
const commit = git("rev-parse", "--short=8", "HEAD")
const dirty = commit !== undefined && (git("status", "--porcelain", "--untracked-files=no", "--", ".", "../shared") ?? "") !== ""
const stamp: BuildInfo = {
  version: (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string }).version,
  ...(commit ? { commit } : {}),
  ...(dirty ? { dirty: true } : {}),
  builtAt: new Date().toISOString(),
  id: randomUUID(),
}

const shared: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "cjs",
  // VS Code 1.90 (the engines floor) runs its extension host on Node 20.
  target: "node20",
  external: ["vscode", "bufferutil", "utf-8-validate"],
  absWorkingDir: pkg,
  logLevel: "warning",
  define: { __NTWINE_BUILD__: JSON.stringify(stamp) },
}

await build({ ...shared, entryPoints: ["src/extension.ts"], outfile: join(dist, "extension.cjs") })
// The app's own icon, the one the web manifest uses.
copyFileSync(join(pkg, "..", "web", "public", "icon-512.png"), join(dist, "icon.png"))
writeFileSync(join(pkg, BUILD_FILE), `${JSON.stringify(stamp, null, 2)}\n`)
const built = ["extension.cjs", "icon.png", "build.json"]

if (process.argv.includes("--e2e")) {
  await build({ ...shared, entryPoints: ["e2e/suite.ts"], outfile: join(dist, "e2e", "suite.cjs") })
  await build({ ...shared, entryPoints: ["e2e/sidebar-agent.ts"], outfile: join(dist, "e2e", "sidebar-agent.cjs") })
  built.push("e2e/suite.cjs", "e2e/sidebar-agent.cjs")
}

console.log(`built packages/vscode/dist (${buildLabel(stamp)}): ${built.join(", ")}`)
