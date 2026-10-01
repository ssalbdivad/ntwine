// Bundle the extension into dist/extension.cjs, which (with the manifest, README, LICENSE and icon) is
// all the .vsix ships. CommonJS because VS Code's extension host loads `main` with require(). `ws`'s
// optional native accelerators stay external — it falls back to pure JS when they are absent, which in
// an editor they always are. `vscode` is provided by the host at runtime.
//
//   nub scripts/build.ts          the extension
//   nub scripts/build.ts --e2e    also the end-to-end suite (dist/e2e/suite.cjs), never packaged

import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build, type BuildOptions } from "esbuild"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(pkg, "dist")
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const shared: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "cjs",
  // VS Code 1.90 (the engines floor) runs its extension host on Node 20.
  target: "node20",
  external: ["vscode", "bufferutil", "utf-8-validate"],
  absWorkingDir: pkg,
  logLevel: "warning",
}

await build({ ...shared, entryPoints: ["src/extension.ts"], outfile: join(dist, "extension.cjs") })
// The app's own icon, the one the desktop app and the web manifest use.
copyFileSync(join(pkg, "..", "web", "public", "icon-512.png"), join(dist, "icon.png"))
const built = ["extension.cjs", "icon.png"]

if (process.argv.includes("--e2e")) {
  await build({ ...shared, entryPoints: ["e2e/suite.ts"], outfile: join(dist, "e2e", "suite.cjs") })
  built.push("e2e/suite.cjs")
  // SPIKE: the sidebar spike's command-loop suite (scripts/sidebar-spike.ts).
  await build({ ...shared, entryPoints: ["e2e/sidebar-suite.ts"], outfile: join(dist, "e2e", "sidebar-suite.cjs") })
  built.push("e2e/sidebar-suite.cjs")
}

console.log(`built packages/vscode/dist: ${built.join(", ")}`)
