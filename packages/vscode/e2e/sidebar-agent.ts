// THE EDITOR'S HALF OF THE REAL-PAGE SIDEBAR RUN — runs INSIDE the VS Code that scripts/e2e-sidebar.ts
// launches (as `--extensionTestsPath`), and does only what needs the editor's API: open a file and select
// in it, read what the extension's sidebar did and what the editor shows, change a setting, run a
// command. Everything a human does — keys, clicks, typing — the harness does from outside, over the
// workbench's debugging port, and everything it asserts about the page it reads from the page itself.
//
// It asks the harness for the next operation over HTTP (NTWINE_E2E_AGENT, a loopback address the harness
// serves), runs it, and posts the answer back, until the harness says `done`.

import { realpathSync } from "node:fs"
import * as vscode from "vscode"
import type { NtwineExtensionApi } from "../src/app.ts"
import { hasShellExecutions } from "../src/extras-feed.ts"

const control = process.env.NTWINE_E2E_AGENT ?? ""

/** `[startLine, startCharacter, endLine, endCharacter]`, 0-based as the API counts; an end character of -1 is the line's end. */
export type Range4 = [number, number, number, number]

export type AgentOp =
  | { op: "status" }
  | { op: "command"; id: string; args?: unknown[] }
  | { op: "open"; path: string; selection?: Range4; preview?: boolean; column?: number; preserveFocus?: boolean }
  | { op: "select"; selection: Range4 }
  | { op: "editor" }
  | { op: "tabs" }
  | { op: "config"; section: string; key: string; value: unknown }
  | { op: "inspect"; section: string; key: string }
  | { op: "install"; vsix: string }
  | { op: "extension"; id: string }
  | { op: "diagnostics"; path: string }
  | { op: "terminal"; command: string }
  | { op: "done" }

export interface AgentStatus {
  version: string
  appName: string
  status: ReturnType<NtwineExtensionApi["status"]>
  sidebar: ReturnType<NtwineExtensionApi["sidebar"]>
  editorContext: ReturnType<NtwineExtensionApi["editorContext"]>
  theme: number
  /** The hint beside the selection as the extension draws it now (null for none). */
  selectionHint: ReturnType<NtwineExtensionApi["selectionHint"]> | null
  /** The threads open in editor tabs. */
  threadTabs: ReturnType<NtwineExtensionApi["threadTabs"]>
}

/** A setting as `inspect` reads it: what each level sets, and what wins. */
export interface SettingState {
  value: unknown
  globalValue: unknown
  workspaceValue: unknown
}

export interface EditorState {
  path: string | null
  selection: { start: [number, number]; end: [number, number] } | null
}

function range(document: vscode.TextDocument, [a, b, c, d]: Range4): vscode.Selection {
  return new vscode.Selection(a, b, c, d < 0 ? document.lineAt(c).text.length : d)
}

/** JSON can't carry a Uri or a class; what a command returned, as plain data. */
function plain(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return String(value)
  }
}

async function perform(api: NtwineExtensionApi, op: AgentOp): Promise<unknown> {
  switch (op.op) {
    case "status":
      return {
        version: vscode.version,
        appName: vscode.env.appName,
        status: api.status(),
        sidebar: api.sidebar(),
        editorContext: api.editorContext(),
        theme: vscode.window.activeColorTheme.kind,
        selectionHint: api.selectionHint() ?? null,
        threadTabs: api.threadTabs(),
      } satisfies AgentStatus
    case "command":
      return plain(await vscode.commands.executeCommand(op.id, ...(op.args ?? [])))
    case "open": {
      const document = await vscode.workspace.openTextDocument(op.path)
      const editor = await vscode.window.showTextDocument(document, { preview: op.preview ?? false, viewColumn: op.column, preserveFocus: op.preserveFocus ?? false })
      if (op.selection) editor.selection = range(document, op.selection)
      return null
    }
    case "select": {
      const editor = vscode.window.activeTextEditor
      if (!editor) throw new Error("no editor in front")
      editor.selection = range(editor.document, op.selection)
      editor.revealRange(editor.selection)
      return null
    }
    case "editor": {
      const editor = vscode.window.activeTextEditor
      const s = editor?.selection
      return {
        path: editor ? realpathSync(editor.document.uri.fsPath) : null,
        selection: s ? { start: [s.start.line, s.start.character], end: [s.end.line, s.end.character] } : null,
      } satisfies EditorState
    }
    case "tabs":
      return vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => ({
        label: tab.label,
        path: tab.input instanceof vscode.TabInputText ? tab.input.uri.fsPath : null,
        active: tab.isActive && group.isActive,
      })))
    case "config":
      // JSON has no `undefined`: a `null` value removes the user's setting, back to its default.
      await vscode.workspace.getConfiguration(op.section).update(op.key, op.value ?? undefined, vscode.ConfigurationTarget.Global)
      return null
    case "inspect": {
      const config = vscode.workspace.getConfiguration(op.section)
      const levels = config.inspect(op.key)
      return { value: config.get(op.key) ?? null, globalValue: levels?.globalValue ?? null, workspaceValue: levels?.workspaceValue ?? null } satisfies SettingState
    }
    case "install":
      // As Extensions: Install from VSIX… does it — into this run's extensions dir, live, with no reload.
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(op.vsix))
      return null
    case "extension":
      // Whether this extension host sees it: what the extension under test reads (extensions.getExtension).
      return vscode.extensions.getExtension(op.id) !== undefined
    case "diagnostics":
      return vscode.languages.getDiagnostics(vscode.Uri.file(op.path)).map((d) => ({
        message: d.message,
        source: d.source ?? null,
        code: typeof d.code === "object" ? String(d.code.value) : d.code ?? null,
        severity: d.severity,
        range: [d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character],
      }))
    case "terminal": {
      // A bash terminal, its command run through shell integration (VS Code 1.93+), and the run's end
      // awaited — what the bar's "Add last terminal command" then offers.
      const terminal = vscode.window.createTerminal({ name: "ntwine e2e", shellPath: "/bin/bash" })
      terminal.show(true)
      if (!hasShellExecutions(vscode.version)) {
        // Before 1.93 shell integration is not the extension API's: `terminal.shellIntegration` is a
        // PROPOSAL there, whose getter throws for an extension that has not declared it — which is what
        // failed c15 on the manifest's floor (1.90), in this harness, not the extension. The command is
        // typed instead, and its end is the terminal's own Copy Last Command naming it — the same terminal
        // shell integration the extension's own 1.90 path reads (extras-feed.ts copiedLastCommand), with
        // the clipboard put back. Its exit code is not reported to extensions before 1.93.
        await terminal.processId
        terminal.sendText(op.command)
        const before = await vscode.env.clipboard.readText()
        const deadline = Date.now() + 30_000
        let seen = false
        try {
          while (!seen && Date.now() < deadline) {
            await vscode.env.clipboard.writeText("")
            await vscode.commands.executeCommand("workbench.action.terminal.copyLastCommand")
            seen = (await vscode.env.clipboard.readText()).trim() === op.command
            if (!seen) await new Promise((resolve) => setTimeout(resolve, 250))
          }
        } finally {
          await vscode.env.clipboard.writeText(before)
        }
        return { exitCode: seen ? "not reported before 1.93" : "timeout" }
      }
      const integrated = terminal as vscode.Terminal & { shellIntegration?: { executeCommand(command: string): unknown } }
      const deadline = Date.now() + 30_000
      while (!integrated.shellIntegration && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
      if (!integrated.shellIntegration) throw new Error("no shell integration in the terminal within 30s")
      const window = vscode.window as unknown as { onDidEndTerminalShellExecution: vscode.Event<{ terminal: vscode.Terminal; exitCode?: number }> }
      const ended = new Promise<number | undefined>((resolve) => {
        const listener = window.onDidEndTerminalShellExecution((event) => {
          if (event.terminal !== terminal) return
          listener.dispose()
          resolve(event.exitCode)
        })
      })
      integrated.shellIntegration.executeCommand(op.command)
      return { exitCode: await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve("timeout"), 30_000))]) }
    }
    case "done":
      return null
  }
}

export async function run(): Promise<void> {
  if (!control) throw new Error("NTWINE_E2E_AGENT is not set: this runs under scripts/e2e-sidebar.ts")
  const extension = vscode.extensions.getExtension<NtwineExtensionApi>("ssalbdivad.ntwine-vscode")
  if (!extension) throw new Error("the extension under test is not installed")
  const api = await extension.activate()
  console.log(`ntwine e2e agent: ${vscode.env.appName} ${vscode.version}, asking ${control}`)
  let seq = 0
  let misses = 0
  for (;;) {
    let next: { seq: number; op: AgentOp } | undefined
    try {
      const response = await fetch(`${control}/next?after=${seq}`)
      misses = 0
      if (response.status === 204) continue
      next = (await response.json()) as { seq: number; op: AgentOp }
    } catch (error) {
      // A harness busy for a moment (a synchronous step) is not a harness gone: a few tries, a second apart.
      if (++misses < 10) {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        continue
      }
      console.log(`ntwine e2e agent: the harness is gone (${(error as Error).message})`)
      return
    }
    seq = next.seq
    let answer: { ok: true; value: unknown } | { ok: false; error: string }
    try {
      answer = { ok: true, value: await perform(api, next.op) }
    } catch (error) {
      answer = { ok: false, error: (error as Error).stack ?? String(error) }
    }
    await fetch(`${control}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seq, ...answer }) }).catch(() => undefined)
    if (next.op.op === "done") return
  }
}
