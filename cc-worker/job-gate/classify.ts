// Which commands the job gate holds, and how heavy each starts out.
//
// Shared by the PreToolUse hook (hook.ts), which must decide in a few milliseconds whether to wrap a
// Bash call, and by ntwine-run (gate.ts), which needs a default estimate and a stable signature for a
// command it has never measured. So this module reads only its arguments: no fs, no /proc.
//
// The lists come from what workers on this machine actually run (a scan of 25k Bash calls across four
// days of transcripts, 2026-10-08): `pnpm test`, `node --conditions ark-ts …/mocha/lib/cli/cli.js`,
// `npx tsc`, `pnpm tsc`, `nub run typecheck`, `nub run test`, `pnpm build`, `npx vitest`,
// `pnpm exec tsc`, `nubx tsc`, `pnpm mocha`, `pnpm prChecks`, `pnpm bench`. An ad hoc
// `node script.ts` is NOT gated: it is the commonest call of all and almost always small, and the gate
// only knows a command by its words.

export type JobClass = "heavy" | "light"

export interface Classified {
  /** The default estimate tier, used until the signature has a measured history. */
  class: JobClass
  /** The command with prefixes (`timeout`, `nice`) and runner scaffolding (`node <path>/mocha.js`) removed. */
  words: string[]
}

// Peak RSS each tier is assumed to need before anything is measured. Heavy matches the observed peaks:
// arktype mocha 2.2–3.2GB, native tsc (tsgo) 1.3–2.4GB, `next build` ~1GB+. Light is lint and the like.
export const DEFAULT_ESTIMATE_MB: Record<JobClass, number> = { heavy: 2560, light: 512 }

// Package-manager script names that are gated. A prefix match, so `testTyped`, `typecheckRepo`,
// `buildDocs`, `benchOperand` all count. `lint` is light: prettier is small, typed eslint is not, and
// the history settles which one a given repo's lint is.
const HEAVY_SCRIPT = /^(test|typecheck|tsc|tsgo|build|mocha|bench|prchecks|vitest|jest|e2e|check-types|check:types)/i
const LIGHT_SCRIPT = /^(lint|eslint)/i

const HEAVY_BIN = new Set(["tsc", "tsgo", "mocha", "_mocha", "vitest", "jest"])
const LIGHT_BIN = new Set(["eslint"])
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun", "nub"])
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx", "nubx"])

// Flags whose VALUE is the next word, per tool. Getting one wrong only misreads the script name, which
// fails toward "not gated" — the safe miss.
const PM_VALUE_FLAGS = new Set(["--filter", "-F", "-C", "--dir", "--prefix", "--workspace", "--cwd", "--reporter", "--loglevel"])
const NODE_VALUE_FLAGS = new Set(["-C", "--conditions", "-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--title", "--stack-size"])
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"])

/** True for a word that only asks for help or a version: such a call is instant whatever the tool. */
const isInfoFlag = (word: string) => word === "--version" || word === "-v" || word === "--help" || word === "-h" || word === "--init" || word === "--showConfig"

/** A call that never ends on its own holds a slot forever; it is never gated. */
const isWatch = (words: string[]) => words.some((w) => w === "--watch" || w === "--watchAll" || w.startsWith("--watch=")) ||
  // `tsc -w`, `vitest watch|dev`, `next dev`. Only for direct binaries: `pnpm -w` means workspace root.
  false

const base = (word: string) => word.slice(word.lastIndexOf("/") + 1)

/** Drop `timeout [opts] DURATION` and `nice [-n N]`, which wrap a command without changing it. */
function stripPrefixes(words: string[]): string[] {
  let rest = words
  for (;;) {
    const head = base(rest[0] ?? "")
    if (head === "timeout") {
      let i = 1
      while (i < rest.length && rest[i].startsWith("-")) i += rest[i] === "-s" || rest[i] === "-k" || rest[i] === "--signal" || rest[i] === "--kill-after" ? 2 : 1
      rest = rest.slice(i + 1) // the DURATION
      continue
    }
    if (head === "nice") {
      let i = 1
      while (i < rest.length && rest[i].startsWith("-")) i += rest[i] === "-n" ? 2 : 1
      rest = rest.slice(i)
      continue
    }
    return rest
  }
}

/** A direct binary call: `tsc -p x`, `./node_modules/.bin/mocha`, `next build`. */
function classifyBinary(words: string[]): Classified | null {
  const head = base(words[0] ?? "")
  const args = words.slice(1)
  if (args.some(isInfoFlag)) return null
  if (HEAVY_BIN.has(head)) {
    if (head === "tsc" || head === "tsgo") {
      if (args.includes("-w") || isWatch(args)) return null
    } else if (head === "vitest") {
      if (args[0] === "watch" || args[0] === "dev" || isWatch(args)) return null
    } else if (isWatch(args) || args.includes("-w")) return null
    return { class: "heavy", words: [head, ...args] }
  }
  if (head === "next") return args[0] === "build" ? { class: "heavy", words: [head, ...args] } : null
  if (LIGHT_BIN.has(head)) return isWatch(args) ? null : { class: "light", words: [head, ...args] }
  return null
}

/** `pnpm --filter x test`, `npm run build`, `nub run typecheck`, `pnpm exec tsc`. */
function classifyPackageManager(words: string[]): Classified | null {
  const head = base(words[0])
  const args = words.slice(1)
  if (isWatch(args)) return null
  let i = 0
  while (i < args.length && args[i].startsWith("-")) {
    if (head === "nub" && args[i] === "--test") return null // a single node:test file
    i += PM_VALUE_FLAGS.has(args[i]) ? 2 : 1
  }
  const sub = args[i]
  if (sub === undefined) return null
  if (sub === "exec" || sub === "dlx" || sub === "x") {
    const inner = classifyBinary(args.slice(i + 1).filter((w, k, all) => !(w.startsWith("-") && k < all.findIndex((x) => !x.startsWith("-")))))
    return inner && { class: inner.class, words: [head, ...args.slice(0, i), sub, ...inner.words] }
  }
  let script: string | undefined
  if (sub === "run" || sub === "run-script") {
    let j = i + 1
    while (j < args.length && args[j].startsWith("-")) j += PM_VALUE_FLAGS.has(args[j]) ? 2 : 1
    script = args[j]
  } else if (sub === "test" || sub === "t" || sub === "tst") {
    script = "test"
  } else if (head === "npm") {
    return null // npm runs a bare word as its own subcommand, never a script
  } else if (head === "nub" && (sub.endsWith(".ts") || sub.includes("/") || sub.endsWith(".js") || sub.endsWith(".mjs"))) {
    return classifyNodeScript(["node", ...args])
  } else {
    script = sub
  }
  if (!script || script.includes("/")) return null
  if (HEAVY_SCRIPT.test(script)) return { class: "heavy", words: [head, ...args] }
  if (LIGHT_SCRIPT.test(script)) return { class: "light", words: [head, ...args] }
  return null
}

/** `node [flags] <script> args`: gated only when the script IS a heavy tool's entry point. */
function classifyNodeScript(words: string[]): Classified | null {
  const args = words.slice(1)
  let i = 0
  while (i < args.length && args[i].startsWith("-")) {
    const flag = args[i]
    if (flag === "-e" || flag === "--eval" || flag === "-p" || flag === "--print" || flag === "--test" || flag === "--run") return null
    i += NODE_VALUE_FLAGS.has(flag) ? 2 : 1
  }
  const script = args[i]
  if (!script) return null
  const rest = args.slice(i + 1)
  if (rest.some(isInfoFlag) || isWatch(rest)) return null
  const name = base(script).replace(/\.(c|m)?js$/, "")
  // mocha's entry is `…/mocha/bin/mocha.js` or `…/mocha/lib/cli/cli.js`; tsc's is `…/typescript/bin/tsc`
  // or, for the native preview, `…/@typescript/typescript-linux-x64/lib/tsc`.
  if (/\/mocha\/(bin|lib\/cli)\//.test(script) || name === "mocha" || name === "_mocha") return { class: "heavy", words: ["mocha", ...rest] }
  if (name === "tsc" || name === "tsgo") return rest.includes("-w") ? null : { class: "heavy", words: [name, ...rest] }
  if (name === "next" && rest[0] === "build") return { class: "heavy", words: ["next", ...rest] }
  if (name === "vitest" && rest[0] !== "watch" && rest[0] !== "dev") return { class: "heavy", words: ["vitest", ...rest] }
  return null
}

/** Classify an argv (already split into shell words). Null means "do not gate". */
export function classify(argv: string[]): Classified | null {
  const words = stripPrefixes(argv)
  const head = base(words[0] ?? "")
  if (!head) return null
  if (PACKAGE_MANAGERS.has(head)) return classifyPackageManager(words)
  if (PACKAGE_RUNNERS.has(head)) {
    let i = 1
    while (i < words.length && words[i].startsWith("-")) i += RUNNER_VALUE_FLAGS.has(words[i]) ? 2 : 1
    const inner = classifyBinary(words.slice(i))
    return inner && { class: inner.class, words: [head, ...inner.words] }
  }
  if (head === "node") return classifyNodeScript(words)
  return classifyBinary(words)
}
