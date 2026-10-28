// `.tsx` for node. Node strips types from `.ts` itself but refuses `.tsx` outright
// (ERR_UNKNOWN_FILE_EXTENSION), and the web package's node:test files import its components. Until
// 2026-10-28 the suite ran under nub, whose loader compiled JSX; this module-loading hook is the piece of
// that loader the suite still needs. It compiles each `.tsx` file with esbuild (already the runtime
// bundler, scripts/build-runtime.mjs) using packages/web/tsconfig.json's own `jsx: react-jsx`, and leaves
// every other file to node.
//
//   node --import ./scripts/tsx-hooks.ts --test packages/web/src/x.test.ts
//
// scripts/run-tests.mjs loads it into every test process, so `pnpm run test <file>` needs nothing extra.
import { transformSync } from "esbuild"
import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !new URL(url).pathname.endsWith(".tsx")) return nextLoad(url, context)
    const path = fileURLToPath(url)
    const { code } = transformSync(readFileSync(path, "utf8"), {
      loader: "tsx",
      jsx: "automatic",
      format: "esm",
      target: "es2023",
      sourcefile: path,
      sourcemap: "inline",
    })
    return { format: "module", source: code, shortCircuit: true }
  },
})
