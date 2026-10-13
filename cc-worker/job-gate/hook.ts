// The Bash-call half of the job gate: rewrite `pnpm test` into `<node> <ntwine-run.ts> -- pnpm test`,
// so the suite waits its turn in the host-wide queue (gate.ts) instead of starting into a full box.
//
// It runs inside bash-background.mjs, the one PreToolUse hook on Bash, rather than as a second hook:
// Claude Code keeps only ONE `updatedInput` when several hooks return one (the last result it reads
// wins; 2.1.290's merge, `if(Te)g=Te`), and bash-background already returns one to lift an untimed
// background call's timeout. Two hooks would race, and whichever lost would silently drop either the
// wrap or the timeout. One process composes both deterministically.
//
// FAIL OPEN, ALWAYS. Anything this module cannot read with certainty is left exactly as written:
// heredocs, command substitution, subshells, braces, shell keywords, a head word that is an expansion.
// The gate is an optimization; a command it misses runs as before, and a command it mangles is a bug.
//
// The rewrite is inserted at the heavy command's own position, after any `NAME=value` assignments, so
// everything around it keeps its meaning: `cd ark/schema && pnpm test 2>&1 | tail -40` becomes
// `cd ark/schema && '<node>' '<ntwine-run.ts>' -- pnpm test 2>&1 | tail -40`. The shell still owns the
// `cd`, the redirect and the pipe; the wrapper inherits the cwd, stdio and environment.
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { classify } from "./classify.ts"

export const NTWINE_RUN = fileURLToPath(new URL("./ntwine-run.ts", import.meta.url))

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "time", "coproc", "!", "{", "}", "[[", "]]"])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const REDIRECT = /^\d*(>>?|<|&>>?|>&|<&|>\|)/

interface Word { text: string; start: number; literal: boolean }
interface Segment { words: Word[]; background: boolean }

/**
 * Split a command line into simple commands at unquoted `;` `&&` `||` `|` `|&` `&` and newlines, with
 * each word's unquoted text and its offset. Null when the line holds anything this reader does not
 * fully understand.
 */
export function segments(command: string): Segment[] | null {
  const out: Segment[] = []
  let words: Word[] = []
  let text = ""
  let start = -1
  let literal = true
  let quote = ""
  const endWord = () => {
    if (start >= 0) words.push({ text, start, literal })
    text = ""
    start = -1
    literal = true
  }
  const endSegment = (background: boolean) => {
    endWord()
    out.push({ words, background })
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote === "'") {
      if (c === "'") quote = ""
      else text += c
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = ""
      else if (c === "\\" && i + 1 < command.length) text += command[++i]
      else if (c === "`" || (c === "$" && command[i + 1] === "(")) return null
      else {
        if (c === "$") literal = false
        text += c
      }
      continue
    }
    if (c === "\\") {
      if (command[i + 1] === "\n") { i++; continue } // line continuation
      if (start < 0) start = i
      text += command[++i] ?? ""
      continue
    }
    if (c === "'" || c === '"') {
      if (start < 0) start = i
      quote = c
      continue
    }
    if (c === "`" || c === "(" || c === ")") return null
    if (c === "$" && command[i + 1] === "(") return null
    if (c === "<" && command[i + 1] === "<") return null // heredoc or herestring
    if (c === "#" && start < 0) { // a comment runs to the end of the line
      while (i + 1 < command.length && command[i + 1] !== "\n") i++
      continue
    }
    if (c === " " || c === "\t") { endWord(); continue }
    if (c === "\n" || c === ";") { endSegment(false); continue }
    if (c === "|") {
      endSegment(false)
      if (command[i + 1] === "|" || command[i + 1] === "&") i++
      continue
    }
    if (c === "&") {
      const prev = command[i - 1]
      if (command[i + 1] === "&") { endSegment(false); i++; continue }
      // `2>&1`, `>&2`, `&>file`: a redirect, part of the current word.
      if (prev === ">" || prev === "<" || command[i + 1] === ">") {
        if (start < 0) start = i
        text += c
        continue
      }
      endSegment(true)
      continue
    }
    if (start < 0) start = i
    if (c === "$" || c === "*" || c === "?" || c === "[" || c === "~" || c === "{") literal = false
    text += c
  }
  if (quote) return null
  endSegment(false)
  return out.filter((s) => s.words.length > 0)
}

/** The argv words of a simple command: its assignments and redirections removed. */
function argvOf(words: Word[]): { head: Word; argv: string[] } | null {
  let i = 0
  while (i < words.length && ASSIGNMENT.test(words[i].text)) i++
  const head = words[i]
  if (!head) return null
  const argv: string[] = []
  for (let k = i; k < words.length; k++) {
    const w = words[k].text
    const redirect = REDIRECT.exec(w)
    if (redirect) {
      if (redirect[0] === w) k++ // the target is the next word
      continue
    }
    argv.push(w)
  }
  return { head, argv }
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * The command with every heavy simple command routed through ntwine-run, or null to leave it alone.
 * `prefix` is the wrapper invocation, already shell-quoted.
 */
export function rewriteCommand(command: string, prefix: string): string | null {
  if (!command.trim() || command.includes("ntwine-run")) return null
  const parsed = segments(command)
  if (!parsed) return null
  const inserts: number[] = []
  for (const segment of parsed) {
    const found = argvOf(segment.words)
    if (!found) continue
    if (KEYWORDS.has(found.head.text)) return null
    if (!found.head.literal) continue
    if (segment.background) continue // bash-background owns `cmd &`
    if (classify(found.argv)) inserts.push(found.head.start)
  }
  if (!inserts.length) return null
  let out = command
  for (const at of inserts.sort((a, b) => b - a)) out = `${out.slice(0, at)}${prefix} ${out.slice(at)}`
  return out
}

/** The off-switch in the host-wide config file, so a running fleet can be switched off at once. */
function gateDisabledByFile(env: Record<string, string | undefined>): boolean {
  try {
    const dir = env.NTWINE_GATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "ntwine", "job-gate")
    return String(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))?.NTWINE_GATE) === "0"
  } catch {
    return false
  }
}

/**
 * The rewritten command for one Bash PreToolUse input, or null. Inert for Codex (it has no
 * `updatedInput`), off Linux (the gate reads /proc), and when switched off.
 */
export function jobGateCommand(input: unknown, env: Record<string, string | undefined> = process.env, execPath = process.execPath): string | null {
  if (process.platform !== "linux") return null
  if (env.NTWINE_GATE === "0" || gateDisabledByFile(env)) return null
  if (!input || typeof input !== "object") return null
  const { tool_input: toolInput, model } = input as Record<string, any>
  if (typeof model === "string") return null
  const command = toolInput?.command
  if (typeof command !== "string") return null
  return rewriteCommand(command, `${shellQuote(execPath)} ${shellQuote(NTWINE_RUN)} --hook --`)
}
