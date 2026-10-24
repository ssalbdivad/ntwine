// A wait's status lines, as the "Wait expired" divider's disclosure shows them to the human.
//
// The scheduler writes them for the WORKER: the fence key it must type and the runtime id it knows the
// child by, then a note that often carries an instruction (`- \`agents: [a8ba0911e38ff92ce]\` — SILENT —
// nothing from it since …; read its transcript, then …`). The disclosure printed that verbatim, so the
// one place the human could look at what a wait named showed fence syntax and an id nobody reads by
// eye. Each line becomes the thing's name and its state: "Sub-agent «Survey the fence grammar» — still
// running". The name comes from the board when the thing is still on it; a child that has left falls
// back to its id, behind its kind.

const KIND_NOUN: Record<string, string> = {
  agents: "Sub-agent",
  shells: "Agent terminal",
  timers: "Timer",
  prs: "PR",
  commands: "Command watch",
  threads: "Thread",
  terminals: "Terminal",
}

/** The state, without the instruction riding after it: the first clause, out of the scheduler's caps. */
function stateOf(note: string): string {
  if (/^the user has not replied\b/.test(note)) return "waiting on you"
  const clause = note.split(/ — |; | \(|, /)[0]!.trim()
  return clause === clause.toUpperCase() ? clause.toLowerCase() : clause.replace(/\b[A-Z]{2,}\b/g, (w) => w.toLowerCase())
}

/** One status line, for the human. `nameOf` resolves a key's value (a runtime id, a handle) to a label,
 *  or undefined. A line in no shape this knows is returned as it came. */
export function parkItemLine(line: string, nameOf: (key: string, value: string) => string | undefined): string {
  const named = /^- `([a-z]+): \[([^\]]*)\]` — (.*)$/.exec(line.trim())
  if (named) {
    const [, key, value, note] = named
    const noun = KIND_NOUN[key!] ?? key!
    const name = nameOf(key!, value!)
    const subject = name ? `${noun} «${name}»` : key === "threads" || key === "terminals" ? `${noun} @${value!.replace(/^@/, "")}` : `${noun} ${value}`
    return `${subject} — ${stateOf(note!)}`
  }
  const counted = /^- `(questions|steps):` \((\d+)\) — (.*)$/.exec(line.trim())
  if (counted) {
    const [, key, n, note] = counted
    const noun = key === "questions" ? (n === "1" ? "question" : "questions") : n === "1" ? "step" : "steps"
    return `${n} ${noun} — ${stateOf(note!)}`
  }
  return line
}
