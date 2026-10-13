import { formatFileReference, type EditorComposeInput, type ProjectCard, type ProjectQueue } from "@ntwine/shared"
import { contextChipLabel, contextDisplayPath, insertTokenIntoProse, isTerminalPath, uniqueToken, type ComposerContextItem } from "./composerContext.ts"
import { draftKey } from "./drafts.ts"
import { joinComposerValue, splitComposerValue } from "./imagePaths.ts"

// WHAT AN EDITOR SENT TO THE PROMPT BOX, put into one — the pure half. "Add to Ntwine prompt" in a VS Code,
// Cursor or Windsurf window (packages/vscode) hands the server a selection or a file reference; the page
// in front claims it (lib/editorBridge.ts) and this decides WHICH box it goes into and WHAT the box's
// draft becomes. The runtime half writes the draft, stages the chip, moves the page and places the caret.
//
// Pure, so every decision here is a unit test rather than a browser session: the target table below is
// the whole rule for where an insert lands, and a wrong row would put someone's code into a prompt for the
// wrong project.

/** One project as a compose target needs it: whose box, and whether this server can take a thread there. */
export interface ComposeProject {
  id: string
  slug: string
  name: string
  /** What its new-thread box's draft is keyed by (lib/drafts.ts) — the poll's reading of its board. */
  projectDir?: string
  /** A board is open for it on this server, so its box can dispatch. */
  open: boolean
}

/** The registered projects, each with what the open-queues read says of it (AllQueues.tsx reads the same pair). */
export function composeProjectsOf(cards: readonly ProjectCard[], queues: readonly ProjectQueue[]): ComposeProject[] {
  const open = new Map(queues.map((queue) => [queue.projectId, queue]))
  return cards.map((card) => {
    const queue = open.get(card.id)
    return { id: card.id, slug: card.slug, name: card.name, open: queue !== undefined && !card.stale, ...(queue ? { projectDir: queue.projectDir } : {}) }
  })
}

export type ComposeTarget =
  /** The reply box of the thread whose drawer is open — whatever project the item names. */
  | { kind: "thread"; slug: string; key: string; projectDir: string }
  /**
   * A project's new-thread box. `move` is what the page does to show it: nothing when it is the page's
   * project already; focused on another, focus that one (the switcher's own verb); showing All projects,
   * make it the prompt box's pick (the picker's own verb).
   */
  | { kind: "new"; key: string; projectDir: string; move: ComposeMove }
  /** Nowhere it can go; `reason` is the toast's second line. */
  | { kind: "refused"; reason: string }

export type ComposeMove = { kind: "stay" } | { kind: "focus"; slug: string } | { kind: "pick"; id: string; slug: string }

export interface ComposeTargetInput {
  item: Pick<EditorComposeInput, "projectId">
  /** The topmost open thread drawer (or the /full page's thread), with its current session. */
  thread?: { slug: string; sessionId?: string }
  /** The page project's live board — what its drafts are keyed by. */
  board?: { projectDir: string; projectSlug?: string }
  /** The page project's slug (base-path.ts projectSlug). */
  pageSlug: string | undefined
  view: "project" | "all"
  projects: readonly ComposeProject[]
}

/**
 * Where an item goes:
 *
 * | the page | the item lands in |
 * | --- | --- |
 * | a thread drawer is open (any project) | that thread's reply box — the human is reading that thread |
 * | its project is the page's | the page's new-thread box |
 * | focused on another project | that project's box, the page focused on it |
 * | All projects, another pick | that project's box, made the pick |
 * | its project is not open here, or unknown | nowhere: refused, and the toast says why |
 *
 * An item with no project (the file is in none the editor knows) goes to the page's own box.
 */
export function composeTarget({ item, thread, board, pageSlug, view, projects }: ComposeTargetInput): ComposeTarget {
  if (thread && board) {
    return { kind: "thread", slug: thread.slug, key: draftKey.followUp(board.projectDir, thread.slug, thread.sessionId), projectDir: board.projectDir }
  }
  const here = pageSlug ?? board?.projectSlug
  const project = item.projectId !== undefined
    ? projects.find((candidate) => candidate.id === item.projectId)
    : projects.find((candidate) => candidate.slug === here)
  if (!project) {
    // No project named, and the project list could not say which the page is: its live board is the box.
    if (item.projectId === undefined && board) return { kind: "new", key: draftKey.dispatch(board.projectDir), projectDir: board.projectDir, move: { kind: "stay" } }
    return { kind: "refused", reason: "Its project isn't in Ntwine." }
  }
  // The page's own board is the freshest reading of its directory; the poll's is the same snapshot value.
  const projectDir = project.slug === here && board ? board.projectDir : project.projectDir
  if (!project.open || !projectDir) return { kind: "refused", reason: `${project.name} isn't open on this server.` }
  const move: ComposeMove = project.slug === here ? { kind: "stay" } : view === "project" ? { kind: "focus", slug: project.slug } : { kind: "pick", id: project.id, slug: project.slug }
  return { kind: "new", key: draftKey.dispatch(projectDir), projectDir, move }
}

export interface ComposeEdit {
  /** The box's whole draft value after the insert (prose, then any attachment lines). */
  value: string
  /** Where the caret goes in the PROSE (the textarea's value): just after the insert and its space. */
  caret: number
  /** The chip to stage under the same draft key, for an item that carries a selection. */
  stage?: Omit<ComposerContextItem, "id">
}

/**
 * The draft after one item: a selection becomes an `@a.ts:12-20` chip — the ⌘I token, so it serializes
 * and renders exactly as a selection made in Ntwine's own viewer (composerContext.ts) — and a reference
 * with no text becomes `` `src/a.ts:12` `` as inline code. Either goes at the END of the prose, after a
 * space where it would glue to a word, with a space after it so typing straight on reads as a sentence:
 * the human was in their editor, not in this box, so there is no caret of theirs to honour. Spliced into
 * the prose, never appended to the raw value: a draft's trailing lines may be attachment paths
 * (imagePaths.ts), and those must stay trailing.
 *
 * `note` is prose the editor wants after the reference, as if typed there ("Ask Ntwine to fix" sends the
 * problem's message: `@a.ts:12 Fix: Cannot find name 'foo'. ts(2304)`). One space between, one after,
 * and the caret after that, so the human's own words carry straight on. A terminal selection
 * (`isTerminalPath`) drops its lines: they are the terminal buffer's, not a file's.
 */
export function composeEdit({ value, staged, item, projectDir, note }: {
  value: string
  staged: readonly { token: string }[]
  item: EditorComposeInput
  projectDir: string | undefined
  note?: string
}): ComposeEdit {
  const { prose, attachments } = splitComposerValue(value)
  const startLine = isTerminalPath(item.path) ? undefined : item.startLine
  const endLine = startLine === undefined ? undefined : Math.max(startLine, item.endLine ?? startLine)
  const lines = startLine === undefined ? {} : { startLine, endLine: endLine! }
  let insert: string
  let stage: ComposeEdit["stage"]
  if (item.text !== undefined && item.text.trim() !== "") {
    insert = uniqueToken(contextChipLabel({ path: item.path, ...lines }), staged, prose)
    stage = { token: insert, path: item.path, text: item.text, ...lines }
  } else {
    const reference = formatFileReference(contextDisplayPath(item.path, projectDir), startLine === undefined ? undefined : { line: startLine, endLine })
    insert = `\`${reference}\``
  }
  const spliced = insertTokenIntoProse(prose, prose.length, insert)
  // The note is one line (the page's parser folds its whitespace), so it can never open a line that
  // splitComposerValue would read as an attachment path.
  const said = note?.trim()
  const next = said ? `${spliced.prose} ${said} ` : `${spliced.prose} `
  return { value: joinComposerValue(next, attachments.map((attachment) => attachment.path)), caret: next.length, ...(stage ? { stage } : {}) }
}
