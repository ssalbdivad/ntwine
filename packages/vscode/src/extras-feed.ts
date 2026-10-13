// THE FILE'S PROBLEMS AND THE TERMINAL'S LAST COMMAND, live — the glue between VS Code and extras.ts.
//
// Two jobs. It tells the sidebar's page what else there is to add (`ntwine:editor-extras`: the file in
// front's problem counts, the last command's line and exit code) after the page says it is ready and on
// every change, debounced like the editor-context feed; and it answers what a click on either (or the
// palette's command) puts in the prompt: the problems' text, or the command with its output.
//
// THE TERMINAL. VS Code 1.93 gave extensions shell integration's commands: `onDidStartTerminalShellExecution`
// hands over each command as it starts, and its `read()` streams what it writes — only from the moment
// it is first called, so it is called at once for every command and the output is kept (the last
// MAX_RAW_CHARS of each, the end being where a failure says what failed) until the next command in that
// terminal replaces it. Nothing leaves the extension host until the human adds it. On an older VS Code
// (the manifest admits 1.90) there is no such API: the entry is offered while a terminal is open, and
// adding it borrows the clipboard for the terminal's own "Copy Last Command" and "Copy Last Command
// Output" (shell integration's commands since 1.79), putting the human's clipboard back after, as the
// terminal selection's entry does (app.ts readTerminalSelection). The 1.93 API is read off `window`
// untyped, since @types/vscode is pinned to the manifest's floor — and only on 1.93 or later, inside a
// try: before 1.93 the same names are there as a PROPOSED API, which throws when an extension that has
// not declared it subscribes, so a presence check passed on 1.90 and the subscription then killed the
// extension's activation (the e2e on the oldest VS Code, 2026-10-02).
//
// Only `import type` from vscode, like app.ts.

import { randomUUID } from "node:crypto"
import type * as vscode from "vscode"
import type { EmbedEditorExtrasMessage } from "@ntwine/shared/embed-protocol"
import { fileLabel } from "./editor-context.ts"
import { extrasMessage, listedProblems, problemCounts, problemsText, terminalCommandText, type FileProblem } from "./extras.ts"

type Vscode = typeof vscode

const DEBOUNCE_MS = 150
/** Characters of a command's raw output kept, its end: a few screens past what a chip can carry. */
const MAX_RAW_CHARS = 256 * 1024

export interface ExtrasHost {
  ready(): boolean
  onReady(listener: (ready: boolean) => void): void
  post(message: EmbedEditorExtrasMessage): Promise<boolean>
}

/** VS Code 1.93's shell integration execution, as much of it as this reads. */
interface ShellExecution {
  commandLine: { value: string }
  read(): AsyncIterable<string>
}
interface ShellExecutionEvent {
  terminal: vscode.Terminal
  execution: ShellExecution
  exitCode?: number
}
interface ShellIntegrationWindow {
  onDidStartTerminalShellExecution?: vscode.Event<ShellExecutionEvent>
  onDidEndTerminalShellExecution?: vscode.Event<ShellExecutionEvent>
}

interface Captured {
  command: string
  chunks: string[]
  size: number
  exitCode?: number
}

export interface ExtrasFeed {
  /** The `@problems` text for the file in front, or why there is none. */
  problems(): { ok: true; text: string } | { ok: false; why: string }
  /** The `@terminal` text for the last command, or why there is none. */
  terminal(): Promise<{ ok: true; text: string } | { ok: false; why: string }>
  /** What the page was last told. */
  last(): EmbedEditorExtrasMessage | undefined
}

/** VS Code 1.93 or later: shell integration's command events are the stable API's. */
export function hasShellExecutions(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10))
  return major > 1 || (major === 1 && minor >= 93)
}

/** Subscribe to shell integration's command events; false where this VS Code does not give them to extensions. */
function subscribeShellExecutions(api: Vscode, context: vscode.ExtensionContext, on: { start(event: ShellExecutionEvent): void; end(event: ShellExecutionEvent): void }): boolean {
  if (!hasShellExecutions(api.version)) return false
  try {
    const shell = api.window as unknown as ShellIntegrationWindow
    if (!shell.onDidStartTerminalShellExecution || !shell.onDidEndTerminalShellExecution) return false
    context.subscriptions.push(shell.onDidStartTerminalShellExecution(on.start), shell.onDidEndTerminalShellExecution(on.end))
    return true
  } catch {
    return false
  }
}

export function registerExtrasFeed(api: Vscode, context: vscode.ExtensionContext, host: ExtrasHost): ExtrasFeed {
  let captures = false
  /** Each terminal's command in flight and its last finished one, and the terminal that finished one last. */
  const running = new Map<vscode.Terminal, Captured>()
  const finished = new Map<vscode.Terminal, Captured>()
  let latest: vscode.Terminal | undefined
  let sent: string | undefined
  let lastMessage: EmbedEditorExtrasMessage | undefined
  let timer: NodeJS.Timeout | undefined

  /** The file editor in front: an output pane or the debug console in front leaves the last file's. */
  const fileEditor = () => {
    const active = api.window.activeTextEditor
    if (active?.document.uri.scheme === "file") return active
    return api.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === "file")
  }

  function fileProblems(uri: vscode.Uri): FileProblem[] {
    return api.languages.getDiagnostics(uri).map((diagnostic) => ({
      line: diagnostic.range.start.line,
      character: diagnostic.range.start.character,
      severity: diagnostic.severity,
      message: diagnostic.message,
      ...(diagnostic.source ? { source: diagnostic.source } : {}),
      ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
    }))
  }

  /** The command the entry names: the active terminal's last, else the last one anywhere. */
  function lastCaptured(): Captured | undefined {
    const active = api.window.activeTerminal
    return (active ? finished.get(active) : undefined) ?? (latest ? finished.get(latest) : undefined)
  }

  function message(): EmbedEditorExtrasMessage {
    const editor = fileEditor()
    const uri = editor?.document.uri
    const problems = uri
      ? { label: fileLabel(uri.fsPath, api.workspace.asRelativePath(uri, (api.workspace.workspaceFolders?.length ?? 0) > 1)), counts: problemCounts(listedProblems(fileProblems(uri))) }
      : undefined
    const captured = lastCaptured()
    const terminal = captures
      ? captured ? { command: captured.command, ...(captured.exitCode !== undefined ? { exitCode: captured.exitCode } : {}) } : undefined
      : api.window.activeTerminal ? {} : undefined
    return extrasMessage({ ...(problems ? { problems } : {}), ...(terminal ? { terminal } : {}) })
  }

  async function send(force: boolean): Promise<void> {
    if (!host.ready()) return
    const next = message()
    const key = JSON.stringify(next)
    if (!force && key === sent) return
    if (await host.post(next)) {
      sent = key
      lastMessage = next
    }
  }

  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void send(false), DEBOUNCE_MS)
  }

  function capture(event: ShellExecutionEvent): void {
    const entry: Captured = { command: event.execution.commandLine.value, chunks: [], size: 0 }
    running.set(event.terminal, entry)
    void (async () => {
      try {
        for await (const chunk of event.execution.read()) {
          entry.chunks.push(chunk)
          entry.size += chunk.length
          while (entry.size > MAX_RAW_CHARS && entry.chunks.length > 1) entry.size -= entry.chunks.shift()!.length
        }
      } catch {
        // A terminal that closed mid-command: what was read so far is what there is.
      }
    })()
  }

  context.subscriptions.push(
    api.window.onDidChangeActiveTextEditor(schedule),
    api.window.onDidChangeVisibleTextEditors(schedule),
    api.languages.onDidChangeDiagnostics(schedule),
    api.window.onDidChangeActiveTerminal(schedule),
    api.window.onDidOpenTerminal(schedule),
    api.window.onDidCloseTerminal((terminal) => {
      running.delete(terminal)
      finished.delete(terminal)
      if (latest === terminal) latest = undefined
      schedule()
    }),
    { dispose: () => clearTimeout(timer) },
  )
  captures = subscribeShellExecutions(api, context, {
    start: (event) => capture(event),
    end(event) {
      // Kept as it is now: `read()` may still be delivering its last chunks, which land in the same
      // entry, and the text is joined only when the human adds it.
      const entry = running.get(event.terminal)
      if (entry && entry.command === event.execution.commandLine.value) {
        running.delete(event.terminal)
        if (event.exitCode !== undefined) entry.exitCode = event.exitCode
        finished.set(event.terminal, entry)
        latest = event.terminal
      }
      schedule()
    },
  })
  host.onReady((ready) => {
    sent = undefined
    if (ready) void send(true)
  })

  /** The terminal's own Copy Last Command / Copy Last Command Output, through a borrowed clipboard. */
  async function copiedLastCommand(): Promise<{ command: string; output: string } | undefined> {
    const commands = await api.commands.getCommands(true)
    if (!commands.includes("workbench.action.terminal.copyLastCommand") || !commands.includes("workbench.action.terminal.copyLastCommandOutput")) return undefined
    const before = await api.env.clipboard.readText()
    const copy = async (command: string) => {
      const marker = `ntwine-terminal-${randomUUID()}`
      await api.env.clipboard.writeText(marker)
      await api.commands.executeCommand(command)
      const copied = await api.env.clipboard.readText()
      return copied === marker ? undefined : copied
    }
    try {
      const command = await copy("workbench.action.terminal.copyLastCommand")
      if (!command?.trim()) return undefined
      return { command, output: (await copy("workbench.action.terminal.copyLastCommandOutput")) ?? "" }
    } finally {
      await api.env.clipboard.writeText(before)
    }
  }

  return {
    problems() {
      const editor = fileEditor()
      if (!editor) return { ok: false, why: "Open a file to add its problems to Ntwine's prompt box." }
      const uri = editor.document.uri
      const label = fileLabel(uri.fsPath, api.workspace.asRelativePath(uri, (api.workspace.workspaceFolders?.length ?? 0) > 1))
      const text = problemsText(label, fileProblems(uri))
      return text ? { ok: true, text } : { ok: false, why: `${label} has no problems to add.` }
    },
    async terminal() {
      const captured = lastCaptured()
      const found = captured
        ? { command: captured.command, output: captured.chunks.join(""), ...(captured.exitCode !== undefined ? { exitCode: captured.exitCode } : {}) }
        : api.window.activeTerminal ? await copiedLastCommand() : undefined
      const text = found ? terminalCommandText(found) : undefined
      return text ? { ok: true, text } : { ok: false, why: "Run a command in VS Code's terminal to add it and its output to Ntwine's prompt box." }
    },
    last: () => lastMessage,
  }
}
