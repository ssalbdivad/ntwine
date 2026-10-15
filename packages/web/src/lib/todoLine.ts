import type { ThreadSkill } from "@ntwine/shared"

// THE `/todo` LINE (2026-10-15): `/todo <task>` in any prompt box writes the task down as a TO-DO — a
// thread with no agent behind it, waiting in Ready until it is started — instead of starting or messaging one. Like `$`,
// it is ntwine's own and is read only where it OPENS the draft; unlike `$` the task may run to several lines,
// because it is the prompt the agent will start on. Undefined ⇒ the words are a prompt. A bare `/todo` is a
// to-do with nothing in it yet: the box is in to-do mode, and Enter does nothing.
export function composerTodoLine(prose: string): { task: string } | undefined {
  const match = /^\/todo(?:\s+([\s\S]*))?$/u.exec(prose.trim())
  return match ? { task: (match[1] ?? "").trim() } : undefined
}

/** The `/` menu's row for it: a command, so it is offered only as the draft's first token. */
export const TODO_SLASH_ITEM: ThreadSkill = {
  name: "todo",
  description: "Add a to-do to Ready without starting an agent",
  source: "ntwine",
  command: true,
}
