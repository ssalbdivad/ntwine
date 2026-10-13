import { shellWriteTargets } from "@ntwine/shared"
import { FILE_WRITING_TOOL_NAMES, normalizedToolName } from "./toolActivity.ts"

// WHEN THE RAIL'S EDITED FILES ARE WORTH RE-READING. The list is computed by the server over the whole
// transcript and rides only the HTTP page read, never the /ws push (app-socket.ts makeTranscriptReader:
// the push fires on every byte-advance, and the reading costs a scan, a stat per file and a git spawn).
// So on a thread with a live push subscription — every open thread, normally — the rail kept the list
// its page load delivered: a file the worker wrote while the maintainer watched never appeared, and a
// file it deleted never left, until a window focus or a remount happened to re-read the page.
//
// The rail re-reads on two edges instead of on every push. A NEW WRITE: the newest tool call in the
// loaded window that could have created, changed or removed a file — a file tool, a Bash redirect or
// in-place edit (the same parser the server uses), or a Bash `rm`/`mv`/git-restore that can delete one.
// That test is deliberately generous: a false positive costs one page read, a false negative costs a
// stale row until the second edge. THE TURN ENDING: whatever the first edge missed (a script that
// deleted files, a write another process made) is settled once per turn.

type ToolLike = { name: string; detail?: string; command?: string; status?: string; edit?: unknown; edits?: readonly unknown[] }
type MessageLike = { sourceId?: string; at?: string; tools?: readonly ToolLike[] }

// Shell verbs that remove or replace a file without writing to it through a redirect.
const SHELL_REMOVAL = /(?:^|[\s;&|(])(?:rm|mv|unlink|git\s+(?:rm|mv|clean|checkout|restore|reset|stash|apply))\b/

function mayChangeFiles(tool: ToolLike): boolean {
  if (tool.edit || tool.edits?.length) return true
  const name = normalizedToolName(tool.name)
  if (FILE_WRITING_TOOL_NAMES.has(name)) return true
  if (name !== "bash" || !tool.command) return false
  return SHELL_REMOVAL.test(tool.command) || shellWriteTargets(tool.command).length > 0
}

/**
 * A key naming the newest tool call in `messages` that may have changed a file, or undefined when there
 * is none. It changes when a newer such call lands AND when that call settles: a call that is still
 * pending has not written anything yet, so a read on its arrival alone would miss the very file it names.
 */
export function newestFileChangeKey(messages: readonly MessageLike[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const tools = message.tools ?? []
    for (let j = tools.length - 1; j >= 0; j--) {
      if (mayChangeFiles(tools[j])) return `${message.sourceId ?? message.at ?? `#${i}`}:${j}:${tools[j].status ?? ""}`
    }
  }
  return undefined
}
