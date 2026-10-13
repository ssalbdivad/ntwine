import type { EditorFront, EditorKind, EditorWindowSummary } from "@ntwine/shared"
import { contextChipLabel, contextDisplayPath } from "./composerContext.ts"

// THE EDITOR BESIDE A BROWSER TAB — the quiet line over a tab's prompt boxes (components/EditorLine.tsx)
// that names what the editor next to it has in front: `VS Code: a.ts:12-20`.
//
// WHY A BROWSER TAB GETS ONE. In an editor's sidebar the context bar reads the editor live and every send
// carries what it names (lib/editorContext.ts). A human talking to a thread from a BROWSER TAB beside VS
// Code has neither: the agent learns what is selected only if it decides to call its `editor` tool
// (ARCHITECTURE.md § VS Code extension), and the human cannot see whether there is
// anything for it to read. So the tab names exactly what that tool would read — the server answers from
// the same window the tool does (server editor-bridge.ts `front`) — and a click adds it as a chip, the
// way the sidebar's bar does, for the human who wants it in the message rather than left to the agent.
// It sends nothing on its own: a tab is not where the human is pointing at code, and context they did
// not choose to send from a surface that cannot show them the switch would be context they cannot stop.
//
// Never the text until the click: the line's reading (`editorFront`) carries the file and the selection's
// lines, and the click asks again for the item (`editorFront({ text: true })`), so what crosses into the
// page is what the human chose to add.
//
// LIVE by a payload-free ping (`editor-front`, api/board-stream.ts), which the server sends when what
// some window shows changed; the line then asks its project again (lib/editorBridge.ts editorFrontChanged
// invalidates the query). Not in the sidebar, which has the whole bar, and not on a phone, where no
// editor is beside the human.

/** The editor's name as the human calls it, from its family; an unknown editor by its own app name. */
const EDITOR_NAME: Partial<Record<EditorKind, string>> = { vscode: "VS Code", cursor: "Cursor", windsurf: "Windsurf" }

export function editorName(front: Pick<EditorFront, "kind" | "app">): string {
  return EDITOR_NAME[front.kind] ?? front.app
}

/** What the line shows and says, from what the server answered. Pure, for its test. */
export interface EditorLineReading {
  /** `VS Code` — said before the reading, so the human knows which window it is. */
  editor: string
  /** `a.ts:12-20`, or with nothing selected `a.ts` — the label the chip a click makes will wear. */
  label: string
  /** The hover: where it is, that agents can read it, and what a click does — or why it cannot. */
  title: string
  /** False for an untitled buffer: no chip can name a file that does not exist. */
  addable: boolean
  selection: boolean
}

export function editorLineReading(front: EditorFront, projectDir: string | null | undefined): EditorLineReading {
  const editor = editorName(front)
  const { selection } = front
  const label = contextChipLabel({ path: front.path, startLine: selection?.startLine, endLine: selection?.endLine })
  const where = front.untitled ? front.path : contextDisplayPath(front.path, projectDir)
  const lines = selection ? (selection.startLine === selection.endLine ? `line ${selection.startLine}` : `lines ${selection.startLine}-${selection.endLine}`) : ""
  // What is true, then what the human can do — "Agents can read it" is the reason the line is here at all:
  // without it, an agent asked about "this" from a tab may not think to look.
  const what = selection ? `${where}, ${lines}, is selected in ${editor}.` : `${where} is open in ${editor}.`
  if (front.untitled) return { editor, label, title: `${what} It isn't saved, so it can't be added here; agents can still read it with their editor tool.`, addable: false, selection: !!selection }
  const secret = front.withheld ? " Its text stays in the editor: the file may hold secrets." : ""
  const add = selection ? "Click to add it here." : "Click to add the file here."
  return { editor, label, title: `${what} Agents can read it with their editor tool.${secret} ${add}`, addable: true, selection: !!selection }
}

/**
 * Whether a prompt box shows the line at all, before asking the server anything: in a browser tab (the
 * sidebar has its bar), not on a phone, and only while some editor window is connected — a page with none
 * never asks. Whether that window has THIS project open and shares its editor is the server's answer.
 */
export function editorLineWanted(state: { embedded: boolean; phone: boolean; windows: readonly EditorWindowSummary[] }): boolean {
  return !state.embedded && !state.phone && state.windows.length > 0
}
