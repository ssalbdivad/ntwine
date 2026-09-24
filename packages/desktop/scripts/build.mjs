// Bundle the Electron main process and its preload into dist/, which is all the packaged app ships.
// Bundled rather than run as TypeScript directly because main.ts reads the server owner record through
// the launcher's own module (src/server-owner.ts), and a workspace import cannot be resolved inside
// an asar. The preload is CommonJS because a sandboxed preload cannot be an ES module.
import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(pkg, "dist")
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const shared = {
  bundle: true,
  platform: "node",
  target: "node24",
  external: ["electron"],
  absWorkingDir: pkg,
  logLevel: "warning",
}
await build({
  ...shared,
  entryPoints: ["src/main.ts"],
  outfile: join(dist, "main.mjs"),
  format: "esm",
  banner: { js: 'import { createRequire as __frizzCreateRequire } from "node:module"; const require = __frizzCreateRequire(import.meta.url);' },
})
await build({ ...shared, entryPoints: ["src/preload.ts"], outfile: join(dist, "preload.cjs"), format: "cjs" })
// The window icon on Linux, and the source electron-builder derives every platform's icon from.
copyFileSync(join(pkg, "..", "web", "public", "icon-512.png"), join(dist, "icon.png"))
console.log("built packages/desktop/dist: main.mjs, preload.cjs, icon.png")
