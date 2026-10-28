// Run with node by artifacts.ts. Keeping the esbuild API in a tiny Node entry means the build drives
// esbuild's platform binary through its JS API rather than executing it directly.
import { basename, dirname, join } from "node:path";
import { build } from "esbuild";

const [output, ...daemonEntries] = process.argv.slice(2);
if (!output) throw new Error("usage: build-runtime.mjs <outfile> [detached-daemon-entry...]");

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  // Some bundled dependencies (including ws) retain CommonJS dynamic `require()` calls for
  // Node built-ins. In an ESM bundle esbuild otherwise installs a throwing require shim. Give
  // that shim a real, bundle-relative CommonJS resolver while preserving ESM/import.meta.
  banner: {
    js: 'import { createRequire as __ntwineCreateRequire } from "node:module"; const require = __ntwineCreateRequire(import.meta.url);',
  },
  external: ["better-sqlite3", "node-pty", "@parcel/watcher", "vite"],
  logLevel: "silent",
};

await build({ ...shared, entryPoints: ["src/index.ts"], outfile: output });

// Detached daemons are spawned as their OWN `node <file>` process, so each needs a real file beside
// the bundle — an import edge is not enough. See packages/server/src/detached-daemons.ts, which owns
// this list and whose resolver looks for exactly these names. artifacts.ts asserts they landed.
for (const entry of daemonEntries) {
  await build({
    ...shared,
    entryPoints: [entry],
    outfile: join(dirname(output), basename(entry).replace(/\.ts$/, ".js")),
  });
}
