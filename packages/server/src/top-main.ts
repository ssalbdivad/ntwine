// Entry for `ntwine top` from the worker's PATH shim (cc-worker/bin/ntwine), which runs under plain node:
// the launchers import top.ts directly, but the shim cannot strip-only load a graph that uses parameter
// properties, so it spawns this file with --experimental-transform-types.
import { runTop } from "./top.ts"

process.exit(await runTop(process.argv.slice(2)))
