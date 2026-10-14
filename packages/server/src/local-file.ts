import { spawn, type SpawnOptions } from "node:child_process"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path"
import { goToArgument, splitFilePosition, type EditorKind, type FilePosition, type LocalFileOpener } from "@ntwine/shared"
import { normalizeLocalPath } from "./local-path.ts"

export type LocalFileOpenResult = { action: "opened"; path: string } | { action: "copy"; path: string }

/** The slice of a ChildProcess the opener needs: the two events that settle a spawn, and unref. */
export interface SpawnedOpener {
  unref(): void
  once(event: "spawn", listener: () => void): unknown
  once(event: "error", listener: (error: Error) => void): unknown
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export type LocalFileSpawn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedOpener

/**
 * Whether the canonical path `real` is `root` or lies beneath it, after resolving `root`'s own links.
 * The one containment rule ntwine has: the openable-roots gate below, and the editor bridge choosing the
 * window whose workspace folder holds a file (editor-bridge.ts), which must agree with it on what
 * "inside" means — a symlinked folder, a Windows path in another case.
 */
export function isUnder(real: string, root: string): boolean {
  let rootReal: string
  try { rootReal = realpathSync(root) } catch { return false }
  if (process.platform !== "win32") {
    return real === rootReal || real.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)
  }
  // Windows realpath can retain the caller's casing. Compare directory identities instead:
  // folding names would also admit distinct siblings in a case-sensitive NTFS directory.
  try {
    const trusted = statSync(rootReal, { bigint: true })
    if (!trusted.isDirectory() || trusted.ino === 0n) return false
    for (let ancestor = real; ;) {
      const actual = statSync(ancestor, { bigint: true })
      if (actual.dev === trusted.dev && actual.ino === trusted.ino) return true
      const parent = dirname(ancestor)
      if (parent === ancestor) return false
      ancestor = parent
    }
  } catch { return false }
}

// Canonicalize before containment so a symlink below a trusted root cannot smuggle a path outside.
// Files only; readers, watchers and openers share the caller's trusted directory roots.
// The image proxy has its own, deliberately path-unconfined resolver.
export function resolveLocalFile(rawPath: string, roots: readonly string[]): string {
  return resolveLocalFileAt(rawPath, roots).path
}

/**
 * resolveLocalFile, plus the place in the file a trailing `:12:3` / `#L12` named. The whole string is
 * tried FIRST, because a file can genuinely be called `notes:12`; only when it does not exist is the
 * suffix split off (shared file-position.ts) and the bare path tried. Until 2026-10-01 there was no
 * second try, so `[x](vscode://file/repo/a.ts:12)` — the link shape agents write most — opened a reader
 * that said the file was not found.
 */
export function resolveLocalFileAt(rawPath: string, roots: readonly string[]): { path: string; position?: FilePosition } {
  rawPath = normalizeLocalPath(rawPath)
  if (!isAbsolute(rawPath)) throw new Error("Local path must be absolute")
  let real: string
  let position: FilePosition | undefined
  try {
    real = realpathSync(rawPath)
  } catch {
    const split = splitFilePosition(rawPath)
    if (!split.position) throw new Error("Local file was not found")
    try { real = realpathSync(split.path) } catch { throw new Error("Local file was not found") }
    position = split.position
  }
  if (!roots.some((root) => isUnder(real, root))) throw new Error("Local file is outside ntwine's trusted roots")
  try {
    if (!statSync(real).isFile()) throw new Error("Local path is not a regular file")
  } catch (error) {
    if (error instanceof Error && error.message === "Local path is not a regular file") throw error
    throw new Error("Local file was not found")
  }
  return position ? { path: real, position } : { path: real }
}

// Resolve a human-written path REFERENCE (as it might appear in inline code) to a canonical openable
// file under `roots`, or null when it doesn't resolve to a real file there. Absolute paths are taken
// as-is; a leading `~`/`~/` expands to the home dir; anything else is resolved relative to the project
// dir (so a repo-relative `packages/web/App.tsx` works). A trailing `:line[:col]` (editor cursor
// suffix) is dropped. Returns null rather than throwing so a batch resolver can score many candidates
// cheaply; the same realpath + containment + is-file gate as resolveLocalFile keeps it confined.
//
// `settle` is the caller's last word on an absolute path before the gate — the router's worktree fallback
// (`mainCheckoutCopy`), which turns a file of a removed worktree into the main checkout's copy.
export function resolveOpenableFile(
  raw: string,
  projectDir: string,
  roots: readonly string[],
  home: string = homedir(),
  settle?: (abs: string) => string,
): string | null {
  const trimmed = raw.trim().replace(/:\d+(?::\d+)?$/, "")
  if (!trimmed) return null
  const abs = trimmed === "~" ? home
    // Either separator after the tilde: a Windows worker writes `~\.claude\CLAUDE.md` (2026-09-11).
    : /^~[\/\\]/.test(trimmed) ? join(home, trimmed.slice(2))
      : isAbsolute(trimmed) ? trimmed
        : resolve(projectDir, trimmed)
  try {
    return resolveLocalFile(settle ? settle(abs) : abs, roots)
  } catch {
    return null
  }
}

/**
 * THE MAIN CHECKOUT'S COPY of a path inside one of the project's worktrees: `<worktreeRoot>/<name>/src/a.ts`
 * → `<projectDir>/src/a.ts`. Undefined for a path outside the worktree folder, and for a worktree folder
 * itself. Pure — whether either file exists is the caller's question.
 *
 * What it is for: a link an agent wrote while it worked in a worktree names the worktree's copy, and the
 * worktree is usually removed once its branch is merged into the main checkout, so the same relative path
 * there is the file the link meant — and the same holds for a file an agent in a worktree names that was
 * never in its worktree at all (`.ntwine/threads/<id>/notes.md`, untracked, lives only in the main
 * checkout). The caller names the folder (router.ts settleWorktreePath: `<project>/.ntwine/worktrees`), and
 * the first segment under it is taken as a worktree's name.
 */
export function mainCheckoutCopy(path: string, projectDir: string, worktreeRoot: string): string | undefined {
  const rel = posix.normalize(relativePath(worktreeRoot, path))
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) return undefined
  const [, ...rest] = rel.split("/").filter(Boolean)
  return rest.length ? join(projectDir, ...rest) : undefined
}

/** `relative` in forward slashes, whichever separator the platform writes. */
function relativePath(from: string, to: string): string {
  return relative(from, to).split(sep).join("/")
}

// A local Markdown file is the ONE local-file kind ntwine renders itself instead of handing to the
// desktop opener, so its bytes are the only ones this gate lets into the page. Both the requested path
// and its canonical real path must carry the extension: a normal `.md` symlink (a skill file linked out
// of `.agents/`) still reads, while a symlink whose target is some other file cannot ride a `.md` href
// into the reader. `.mdx` is Markdown here too — see the web's `MARKDOWN_FILE_PATH`, which this must
// match.
export const MARKDOWN_FILE_EXT = /\.(?:md|mdx|markdown)$/i

// Ceiling on one click's read. A rendered document is prose a person is about to read, not a data
// channel — past a megabyte the renderer is the wrong tool and the browser pays for the whole string.
// Over the cap the reader still opens, truncated at a line boundary, and says so.
export const MARKDOWN_READ_LIMIT = 1024 * 1024

export type LocalMarkdownRead = { path: string; markdown: string; truncated: boolean }

export type LocalTextRead = { path: string; text: string; truncated: boolean }

/**
 * A file's source, for the fullscreen page's file viewer (the "edited files" rail, 2026-08-28).
 *
 * The SAME openable roots as the Markdown reader, deliberately: this gate was the project directory
 * alone until 2026-09-03, on the premise that "the files it exists for are the ones a worker just
 * edited in the checkout, so nothing under `~` needs to be readable here". That premise is false —
 * a worker's checkout is very often NOT the project directory. Over two weeks of this machine's
 * transcripts, 41% of every file a worker wrote sat outside every registered project dir: git
 * worktrees at `~/.cache/<tool>/worktrees/<slug>/`, sibling clones, `/tmp` scratch, the project's own
 * `attachments` state dir. Every one of those rail rows answered a click with "Local file is outside
 * ntwine's trusted roots" — while a `.md` in the SAME directory opened fine through the reader, which
 * had home-and-below all along (maintainer 2026-09-03: "why do we have this? I see it a lot, and it's
 * annoying").
 *
 * The narrower gate also bought no security it was the last line of. In exposed mode (`--host` /
 * `--public-origin`) every request needs a board session, and anyone holding one can already dispatch a
 * worker that reads any file on the machine and prints it into a transcript — and `openLocalFile`
 * already spawns the desktop opener on anything under home. The origin check and the session are the
 * boundary; this is defense in depth behind them, and it stays exactly as wide as the reader's.
 *
 * Binary is refused rather than rendered as noise: a NUL in the first 8 KiB is the classic tell and the
 * viewer is a text surface. Same 1 MiB line-boundary truncation as the Markdown reader.
 */
export function readLocalTextFile(rawPath: string, roots: readonly string[]): LocalTextRead {
  const path = resolveLocalFile(rawPath, roots)
  const bytes = readFileSync(path)
  if (bytes.subarray(0, 8192).includes(0)) throw new Error("Local file is not a text file")
  if (bytes.length <= MARKDOWN_READ_LIMIT) return { path, text: bytes.toString("utf8"), truncated: false }
  const head = bytes.subarray(0, MARKDOWN_READ_LIMIT)
  const lastBreak = head.lastIndexOf(0x0a)
  return { path, text: head.subarray(0, lastBreak > 0 ? lastBreak : head.length).toString("utf8"), truncated: true }
}

export function readLocalMarkdown(rawPath: string, roots: readonly string[]): LocalMarkdownRead {
  if (!MARKDOWN_FILE_EXT.test(rawPath.trim())) throw new Error("Local file is not a Markdown file")
  const path = resolveLocalFile(rawPath, roots)
  if (!MARKDOWN_FILE_EXT.test(path)) throw new Error("Local file is not a Markdown file")
  const bytes = readFileSync(path)
  if (bytes.length <= MARKDOWN_READ_LIMIT) return { path, markdown: bytes.toString("utf8"), truncated: false }
  // Cut on the last newline inside the cap so the tail is a whole line rather than a split multi-byte
  // character or half a fenced block; fall back to the raw cap if the prefix holds no newline at all.
  const head = bytes.subarray(0, MARKDOWN_READ_LIMIT)
  const lastBreak = head.lastIndexOf(0x0a)
  return { path, markdown: head.subarray(0, lastBreak > 0 ? lastBreak : head.length).toString("utf8"), truncated: true }
}

/**
 * The path a LIVE WATCH of a file may attach to — exactly the gate its read passed, or nothing. Both
 * readers now share one set of roots, so the containment is one call; the only asymmetry left is the
 * Markdown one, where the CANONICAL path must be Markdown too. A watch reveals only "this changed",
 * but a file the reader is not allowed to read is not one it may be told about either — so a `.md`
 * href whose target is some other file arms nothing, exactly as it reads nothing.
 */
export function resolveWatchableLocalFile(rawPath: string, roots: readonly string[]): string {
  const path = resolveLocalFile(rawPath, roots)
  if (MARKDOWN_FILE_EXT.test(rawPath.trim()) && !MARKDOWN_FILE_EXT.test(path)) {
    throw new Error("Local file is not a Markdown file")
  }
  return path
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedOpener {
  return spawn(command, [...args], options)
}

/**
 * Wait for a detached opener to either start or fail to start, and turn the failure into an error the
 * RPC can carry. A `spawn` failure (ENOENT above all) arrives as an asynchronous `error` EVENT on the
 * ChildProcess, and an `error` event nobody listens for THROWS — out of the event loop, into the
 * control-plane child's `uncaughtException` handler, which exits the process. That is how one click
 * on a file link took the whole board down on Windows, where `xdg-open` does not exist and `cursor` /
 * `code` are `.cmd` shims libuv cannot find (Windows audit 2026-09-11, finding 1). `src/cloud.ts`
 * attaches the same listener to cloudflared for the same reason.
 */
export async function awaitOpenerStart(child: SpawnedOpener, command: string): Promise<void> {
  child.unref()
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => reject(new Error(
      error.code === "ENOENT"
        ? `${command} is not installed or not on PATH`
        : `could not start ${command}: ${error.message}`,
    )))
    child.once("spawn", resolve)
  })
}

/**
 * Wait until the opener has HANDED THE PATH OFF — the point the window is up or about to be — rather
 * than merely started. Every GUI opener ntwine runs is a launcher that exits once the app has the path:
 * `code`/`cursor` exit when the running instance (or the one it started) acknowledges the window — over
 * WSL after the remote handshake too, which is the multi-second part — `open -a`, `xdg-open` and
 * `explorer.exe` once the handler is dispatched. So the exit is the "it is showing" signal the page
 * keeps its spinner for (2026-09-30: an RPC that answered at spawn left seconds of nothing before
 * VS Code appeared, and the key got pressed again). A launcher that exits non-zero failed, and says so;
 * `explorer.exe` is the exception, returning 1 on success. An opener that never exits — a terminal
 * `$EDITOR` detached from any tty — resolves at `capMs`, since nothing better is coming.
 */
export async function awaitOpenerHandoff(child: SpawnedOpener, command: string, capMs = OPENER_HANDOFF_CAP_MS): Promise<void> {
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
  await awaitOpenerStart(child, command)
  let timer: NodeJS.Timeout | undefined
  const code = await Promise.race([exited, new Promise<"cap">((resolve) => { timer = setTimeout(resolve, capMs, "cap"); timer.unref?.() })])
  clearTimeout(timer)
  if (typeof code === "number" && code !== 0 && !/(^|[\\/])explorer(\.exe)?$/iu.test(command)) {
    throw new Error(`${command} exited with code ${code}`)
  }
}
export const OPENER_HANDOFF_CAP_MS = 30_000

export interface OpenerCommand {
  command: string
  args: readonly string[]
  /** Hand `args` to the process VERBATIM (the `cmd.exe /c` shape, whose one argument is already quoted). */
  verbatim?: boolean
}

export interface OpenerCommandOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Probe for an editor's real executable (tests point it at a fixture). */
  exists?: (path: string) => boolean
  /** Where in the file to land, for the openers that can be told (an editor; never the system opener). */
  position?: FilePosition
}

// Where the two editors' user-scope installers put the real executable on Windows. The `cursor` /
// `code` names on PATH there are `.cmd` shims beside them, and node has refused to spawn a `.cmd`
// without a shell since CVE-2024-27980 — so the exe is what to run when it is where it usually is.
const WINDOWS_EDITOR_EXE: Record<"cursor" | "vscode", { exe: readonly string[]; shim: string }> = {
  cursor: { exe: ["Programs", "cursor", "Cursor.exe"], shim: "cursor" },
  vscode: { exe: ["Programs", "Microsoft VS Code", "Code.exe"], shim: "code" },
}

// Editors that draw in the terminal they are started from. The opener is detached with no stdio, so
// one of these would start with no terminal and exit (or hang) invisibly — refuse it with a reason
// instead. Matched on the executable's basename, minus a Windows `.exe`.
const TERMINAL_EDITORS = new Set([
  "vi", "vim", "nvim", "view", "vimx", "nano", "pico", "micro", "hx", "helix", "kak", "joe", "jed",
  "ne", "mg", "ed", "ex", "emacsclient-nw", "amp", "vis", "zile",
])

// A shell-word split, quotes only (`code --wait`, `"/Applications/Sublime Text.app/…/subl" -w`). No
// expansion of any kind, because nothing here runs through a shell: the words become an argv.
function splitEditorCommand(raw: string): string[] {
  const words: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of raw.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3]!)
  return words
}

/** An editor command's executable as a bare lowercase name: `/usr/bin/code` and `C:\…\Code.exe` are both `code`. */
function editorExecutableName(word: string | undefined): string {
  return (word ?? "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "")
}

function isTerminalEditor(words: readonly string[]): boolean {
  const name = editorExecutableName(words[0])
  // `emacs` is a GUI app unless told otherwise; `emacs -nw` / `emacsclient -t` are the terminal forms.
  if (name === "emacs" || name === "emacsclient") return words.some((w) => w === "-nw" || w === "-t" || w === "--tty")
  return TERMINAL_EDITORS.has(name)
}

/**
 * The editor `$VISUAL` / `$EDITOR` names, as an argv. `$VISUAL` is the conventional "full-screen
 * editor" and wins when it is usable; when it names a terminal editor, a GUI `$EDITOR` still serves
 * (the common `VISUAL=nvim EDITOR=…` split runs the other way, so both are tried). Throws a reason the
 * RPC carries to the toast when neither names an editor that can open without a terminal.
 */
export function envEditorCommand(env: NodeJS.ProcessEnv): string[] {
  const candidates = [env.VISUAL, env.EDITOR].map((raw) => splitEditorCommand(raw?.trim() ?? "")).filter((w) => w.length > 0)
  if (candidates.length === 0) throw new Error("$EDITOR is not set where ntwine was started")
  const usable = candidates.find((words) => !isTerminalEditor(words))
  if (!usable) throw new Error(`$EDITOR is ${candidates[0]![0]}, which needs a terminal; set a GUI editor`)
  return usable
}

// How an `$EDITOR` is told a line. The VS Code family takes `-g path:line:col` (a bare `path:12` is a
// file NAMED that to it); Sublime and Zed parse the suffix off the path itself. Anything else gets the
// path alone — guessing a flag for an editor that does not take one would open a file called `-g`.
const GOTO_FLAG_EDITORS = new Set(["code", "code-insiders", "cursor", "codium", "windsurf"])
const GOTO_SUFFIX_EDITORS = new Set(["subl", "sublime_text", "zed"])

function envEditorTarget(command: string, path: string, position: FilePosition | undefined): string[] {
  if (!position) return [path]
  const name = editorExecutableName(command)
  if (GOTO_FLAG_EDITORS.has(name)) return ["-g", goToArgument(path, position)]
  if (GOTO_SUFFIX_EDITORS.has(name)) return [goToArgument(path, position)]
  return [path]
}

/**
 * The editor families a connected editor window must belong to before the editor bridge may take an
 * open the Local file links setting would otherwise hand to a spawn (editor-bridge.ts): the family that
 * spawn would have launched, and nothing else. `system`, `finder` and `copy` are never an editor; for
 * `editor` it is whatever `$VISUAL`/`$EDITOR` runs, and only the families an extension can live in.
 */
export function editorKindsForOpener(opener: LocalFileOpener | "editor", env: NodeJS.ProcessEnv): EditorKind[] {
  if (opener === "vscode") return ["vscode"]
  if (opener === "cursor") return ["cursor"]
  if (opener !== "editor") return []
  let words: string[]
  try { words = envEditorCommand(env) } catch { return [] }
  const name = editorExecutableName(words[0])
  if (name === "code" || name === "code-insiders") return ["vscode"]
  if (name === "cursor") return ["cursor"]
  if (name === "windsurf") return ["windsurf"]
  return []
}

// The CLI inside each editor's macOS app bundle — what `code` / `cursor` on PATH link to once the human
// runs "Install 'code' command in PATH", which a GUI-launched ntwine cannot count on having on its PATH.
// It is the only macOS opener that takes a line silently: `open -a <app> a.ts:12` opens a file NAMED
// that, and `open vscode://file/a.ts:12` makes VS Code (and Cursor, its fork) stop on a confirmation
// dialog every time until the human ticks it off (security.promptForLocalFileProtocolHandling).
const MAC_EDITOR_APP: Record<"cursor" | "vscode", { app: string; cli: string }> = {
  cursor: { app: "Cursor", cli: "cursor" },
  vscode: { app: "Visual Studio Code", cli: "code" },
}

/** The bundle CLI of a drag-installed editor: /Applications, then a per-user ~/Applications. */
function macEditorCli(selected: "cursor" | "vscode", env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  const { app, cli } = MAC_EDITOR_APP[selected]
  const roots = ["/Applications", ...(env.HOME ? [posix.join(env.HOME, "Applications")] : [])]
  for (const root of roots) {
    const path = posix.join(root, `${app}.app`, "Contents", "Resources", "app", "bin", cli)
    if (exists(path)) return path
  }
  return undefined
}

/**
 * The fixed command plus argv that opens `path` with the selected app on `platform`. Pure over its
 * inputs so the Windows shapes are testable from a Mac.
 *
 * Windows: the system opener is `explorer.exe <path>` (the shell's own "open with the registered
 * handler"), reveal is `explorer.exe /select,<path>`. An editor runs its real executable when the
 * user-scope installer put it under `%LOCALAPPDATA%\Programs`; otherwise the `.cmd` shim on PATH is
 * run THROUGH `cmd.exe`, with the path quoted inside the one verbatim argument — never `shell: true`
 * with a bare string, which would let a path's `&` or `^` become syntax. A Windows path cannot contain
 * `"`, so quoting it is complete; `%` is refused because cmd.exe expands `%name%` even inside quotes.
 */
export function localFileOpenCommand(path: string, selected: Exclude<LocalFileOpener, "copy">, options: OpenerCommandOptions = {}): OpenerCommand {
  const platform = options.platform ?? process.platform
  const position = options.position
  if (selected === "editor") {
    const [command, ...args] = envEditorCommand(options.env ?? process.env)
    const target = envEditorTarget(command!, path, position)
    if (platform !== "win32" || /\.exe$/i.test(command!)) return { command: command!, args: [...args, ...target] }
    // A bare name on Windows is usually a `.cmd` shim (`code`, `subl`), which node will not spawn
    // without a shell — so the same quoted `cmd.exe /c` shape as the editor shims below.
    const words = [command!, ...args, ...target]
    if (words.some((w) => /["%\r\n]/u.test(w))) throw new Error(`cannot hand ${path} to ${command} through cmd.exe`)
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${words.map((w) => `"${w}"`).join(" ")}"`], verbatim: true }
  }
  // `code -g path:12:3` / `cursor -g …`: the one argv both editors' CLIs take a line in.
  const editorTarget = position ? ["-g", goToArgument(path, position)] : [path]
  if (platform === "darwin") {
    if (selected === "finder") return { command: "open", args: ["-R", path] }
    if (selected === "system") return { command: "open", args: [path] }
    // A line needs the bundle's CLI; without one the file still opens, at its top.
    const cli = position ? macEditorCli(selected, options.env ?? process.env, options.exists ?? existsSync) : undefined
    if (cli) return { command: cli, args: editorTarget }
    return { command: "open", args: ["-a", MAC_EDITOR_APP[selected].app, path] }
  }
  if (platform === "win32") {
    if (selected === "system") return { command: "explorer.exe", args: [path] }
    if (selected === "finder") return { command: "explorer.exe", args: [`/select,${path}`] }
    const editor = WINDOWS_EDITOR_EXE[selected]
    const env = options.env ?? process.env
    const exists = options.exists ?? existsSync
    const localAppData = env.LOCALAPPDATA
    if (localAppData) {
      const exe = join(localAppData, ...editor.exe)
      if (exists(exe)) return { command: exe, args: editorTarget }
    }
    if (/["%\r\n]/u.test(path)) throw new Error(`cannot hand ${path} to the ${editor.shim} shim through cmd.exe`)
    const quoted = position ? `-g "${goToArgument(path, position)}"` : `"${path}"`
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${editor.shim} ${quoted}"`], verbatim: true }
  }
  return selected === "cursor" ? { command: "cursor", args: editorTarget }
    : selected === "vscode" ? { command: "code", args: editorTarget }
      : { command: "xdg-open", args: [path] }
}

// Open only a previously canonicalized, allowlisted local path. No shell is ever involved; each
// platform integration gets a fixed command plus an argv array. `copy` deliberately performs no OS
// action: the trusted same-origin client writes the returned canonical path to its clipboard.
// Resolves once the opener has handed the file off (awaitOpenerHandoff), and rejects — as the RPC's
// error — when it cannot.
export async function openLocalFile(
  rawPath: string,
  opener: LocalFileOpener,
  roots: readonly string[],
  options: { forceSystem?: boolean; spawn?: LocalFileSpawn } & OpenerCommandOptions = {},
): Promise<LocalFileOpenResult> {
  const { path, position } = resolveLocalFileAt(rawPath, roots)
  const selected = options.forceSystem ? "system" : opener
  if (selected === "copy") return { action: "copy", path }

  // An explicit position (the page read it off the link) wins over one split off the path itself.
  const spec = localFileOpenCommand(path, selected, { ...options, position: options.position ?? position })
  const child = (options.spawn ?? defaultSpawn)(spec.command, spec.args, {
    detached: true, stdio: "ignore", shell: false, windowsHide: true,
    ...(spec.verbatim ? { windowsVerbatimArguments: true } : {}),
  })
  await awaitOpenerHandoff(child, spec.command)
  return { action: "opened", path }
}

/**
 * Which editor a FOLDER opens in — a thread's working directory, the "Open in editor" action. The
 * Local file links setting when it names an editor; otherwise `$VISUAL`/`$EDITOR`, because the other
 * settings mean nothing for a folder (the system opener and Reveal hand it to a file manager, Copy
 * path is not an editor). Throws a reason for the toast when neither gives an editor.
 */
export function folderEditor(opener: LocalFileOpener, env: NodeJS.ProcessEnv): "cursor" | "vscode" | "editor" {
  if (opener === "cursor" || opener === "vscode" || opener === "editor") return opener
  try {
    envEditorCommand(env)
    return "editor"
  } catch {
    throw new Error("Set Local file links to an editor in Settings")
  }
}

/**
 * Open a directory the SERVER resolved (never a path from the page) in an editor. Every editor
 * `localFileOpenCommand` knows takes a folder as its argument — `code <dir>`, `cursor <dir>`,
 * `open -a … <dir>`, `subl <dir>`, `zed <dir>` — so the argv is the file one with the folder in its
 * place.
 */
export async function openLocalFolder(
  dir: string,
  opener: LocalFileOpener,
  options: { spawn?: LocalFileSpawn } & OpenerCommandOptions = {},
): Promise<{ path: string }> {
  let isDir = false
  try { isDir = statSync(dir).isDirectory() } catch {}
  if (!isDir) throw new Error(`${dir} is not a folder`)
  const spec = localFileOpenCommand(dir, folderEditor(opener, options.env ?? process.env), options)
  const child = (options.spawn ?? defaultSpawn)(spec.command, spec.args, {
    detached: true, stdio: "ignore", shell: false, windowsHide: true,
    ...(spec.verbatim ? { windowsVerbatimArguments: true } : {}),
  })
  await awaitOpenerHandoff(child, spec.command)
  return { path: dir }
}
