// THE FILE'S PROBLEMS AND THE TERMINAL'S LAST COMMAND, as the sidebar's prompt takes them — the pure half.
//
// Cursor's @Lint errors and Copilot's #problems put the editor's diagnostics for the file in front into
// the prompt; Copilot's #terminalLastCommand and Claude Code's terminal mention put the last command and
// its output there. Here each is one chip in the sidebar's prompt box: `@problems` (embed-protocol.ts
// EMBED_PROBLEMS_PATH) and `@terminal` (EMBED_TERMINAL_PATH, the chip a terminal selection already makes),
// whose quoted text is what this module writes. The chip's text is what the agent reads, so it says what
// it is in its first line — the file and its counts, or the command line — and stays inside what a
// compose item may carry (message.ts `composable`): a long output keeps its END, where the error is.
//
// The bar's menu offers each only when there is one (`extrasMessage`), and the page is told counts and a
// command line, never the problems' text or the output, until the human adds them.
//
// No `vscode` here (extras.test.ts); extras-feed.ts is the glue.

import { EMBED_MAX_COMMAND, type EmbedEditorExtrasMessage } from "@ntwine/shared/embed-protocol"
import { composable, normalizeNewlines, QUOTE_MAX_BYTES, QUOTE_MAX_LINES } from "./message.ts"

// ── problems ─────────────────────────────────────────────────────────────────────────────────────────

/** A diagnostic as VS Code holds one, reduced to what the chip says. Severity: VS Code's enum (Error 0 … Hint 3). */
export interface FileProblem {
  /** 0-based, as `Diagnostic.range.start` has it. */
  line: number
  character: number
  severity: number
  message: string
  source?: string
  code?: string | number | { value: string | number }
}

const SEVERITY = ["error", "warning", "info"] as const
/** Problems one chip carries at most; the first line says how many there were. */
export const MAX_PROBLEMS = 50
const MAX_MESSAGE = 300

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim()

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

/** What the Problems panel would list for the file: errors, warnings and infos (a hint is a faded squiggle, never listed). */
export function listedProblems(problems: readonly FileProblem[]): FileProblem[] {
  return problems
    .filter((problem) => problem.severity >= 0 && problem.severity <= 2)
    .sort((a, b) => a.severity - b.severity || a.line - b.line || a.character - b.character)
}

export function problemCounts(problems: readonly FileProblem[]): { errors: number; warnings: number; infos: number } {
  const counts = { errors: 0, warnings: 0, infos: 0 }
  for (const problem of problems) {
    if (problem.severity === 0) counts.errors++
    else if (problem.severity === 1) counts.warnings++
    else if (problem.severity === 2) counts.infos++
  }
  return counts
}

/** `2 errors, 1 warning` — the counts that are not zero. */
export function countsPhrase(counts: { errors: number; warnings: number; infos: number }): string {
  return [
    counts.errors ? plural(counts.errors, "error") : "",
    counts.warnings ? plural(counts.warnings, "warning") : "",
    counts.infos ? plural(counts.infos, "info") : "",
  ].filter(Boolean).join(", ")
}

/**
 * The `@problems` chip's text: the file and its counts, then one problem a line as the Problems panel
 * reads it — `12:5 error Cannot find name 'foo'. ts(2304)` — errors first, then by line. Undefined for a
 * file with nothing listed. Past MAX_PROBLEMS, or past what a chip carries, the rest are counted, not
 * dropped silently.
 */
export function problemsText(label: string, problems: readonly FileProblem[]): string | undefined {
  const listed = listedProblems(problems)
  if (!listed.length) return undefined
  const head = `Problems in ${label}: ${countsPhrase(problemCounts(listed))}`
  const lines = listed.map((problem) => {
    const code = typeof problem.code === "object" ? problem.code.value : problem.code
    const source = problem.source ? oneLine(problem.source) : ""
    const tag = code === undefined || code === "" ? source : `${source}(${oneLine(String(code))})`
    return [`${problem.line + 1}:${problem.character + 1}`, SEVERITY[problem.severity], clip(oneLine(problem.message), MAX_MESSAGE), tag].filter(Boolean).join(" ")
  })
  const kept: string[] = []
  for (const line of lines.slice(0, MAX_PROBLEMS)) {
    const next = [head, ...kept, line].join("\n")
    if (!composable({ text: next, startLine: 1, endLine: kept.length + 2 })) break
    kept.push(line)
  }
  const left = listed.length - kept.length
  return [head, ...kept, ...(left > 0 ? [`… and ${left} more`] : [])].join("\n")
}

// ── the terminal's last command ──────────────────────────────────────────────────────────────────────

/**
 * Terminal output as text: the escape sequences a terminal paints with removed (colours, cursor moves,
 * window titles, shell integration's own marks), a carriage return that redraws a line (a progress bar)
 * keeping only what was drawn last, and backspaces applied.
 */
export function plainTerminalText(raw: string): string {
  const stripped = raw
    // OSC: ESC ] … BEL or ESC \ (titles, links, VS Code's 633 marks).
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/gu, "")
    // CSI: ESC [ params intermediates final.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    // Any other two-character escape, and a lone ESC.
    .replace(/\u001b[@-Z\\-_]?/gu, "")
  const lines = stripped.replace(/\r\n/gu, "\n").split("\n").map((line) => {
    // What a carriage return leaves on screen: the last segment drawn over the start of the line.
    const drawn = line.split("\r").reduce((screen, segment) => segment + screen.slice(segment.length), "")
    let out = ""
    for (const char of drawn) out = char === "\b" ? out.slice(0, -1) : out + char
    // Other control characters paint nothing.
    return out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").replace(/\s+$/u, "")
  })
  return lines.join("\n").replace(/^\n+|\n+$/gu, "")
}

/**
 * The `@terminal` chip's text for a command: `$ <command>`, its output, and how it exited — or undefined
 * when there is no command to name. An output too long for a chip keeps its LAST lines, where a failure
 * says what failed, under a line that says how many came before.
 */
export function terminalCommandText(input: { command: string; output: string; exitCode?: number }): string | undefined {
  const command = normalizeNewlines(input.command).trim()
  if (!command) return undefined
  const head = `$ ${command}`
  const tail = input.exitCode === undefined ? [] : [`(exit code ${input.exitCode})`]
  const output = plainTerminalText(normalizeNewlines(input.output))
  const outputLines = output ? output.split("\n") : []
  // Fit from the end: the most recent lines first, while the whole still fits a chip.
  const budgetLines = QUOTE_MAX_LINES - 2 - tail.length - 1
  let kept = outputLines.slice(-budgetLines)
  const fits = (lines: readonly string[]) => {
    const text = [head, ...(lines.length < outputLines.length ? [`… ${outputLines.length - lines.length} earlier lines`] : []), ...lines, ...tail].join("\n")
    return composable({ text, startLine: 1, endLine: text.split("\n").length }) && Buffer.byteLength(text, "utf8") <= QUOTE_MAX_BYTES
  }
  while (kept.length && !fits(kept)) kept = kept.slice(Math.max(1, Math.floor(kept.length / 8)))
  const skipped = outputLines.length - kept.length
  return [head, ...(skipped ? [`… ${skipped} earlier lines`] : []), ...kept, ...tail].join("\n")
}

// ── what the bar's menu is told ──────────────────────────────────────────────────────────────────────

/** The `ntwine:editor-extras` message: only what there is to offer, the command line clipped to one line. */
export function extrasMessage(input: {
  problems?: { label: string; counts: { errors: number; warnings: number; infos: number } }
  terminal?: { command?: string; exitCode?: number }
}): EmbedEditorExtrasMessage {
  const counts = input.problems?.counts
  const problems = input.problems && counts && counts.errors + counts.warnings + counts.infos > 0 ? { label: input.problems.label, ...counts } : undefined
  const command = input.terminal?.command ? clip(oneLine(input.terminal.command), EMBED_MAX_COMMAND) : undefined
  const terminal = input.terminal
    ? { ...(command ? { command } : {}), ...(input.terminal.exitCode !== undefined ? { exitCode: input.terminal.exitCode } : {}) }
    : undefined
  return { type: "ntwine:editor-extras", ...(problems ? { problems } : {}), ...(terminal ? { terminal } : {}) }
}
