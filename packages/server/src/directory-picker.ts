import { execFile, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

const run = promisify(execFile)

// THE NATIVE FOLDER PICKER, opened by the SERVER rather than the browser.
//
// It has to be the server, and that is not a shortcut. The browser's own File System Access API
// (`showDirectoryPicker`) hands back a FileSystemDirectoryHandle carrying the directory's NAME and
// nothing else — deliberately, since exposing absolute paths to a web page is the thing it exists to
// prevent. Ntwine needs the path: a project IS a path. So the process that already lives on the
// machine, and already opens browsers and app windows, opens the picker too.
//
// A picker is not available everywhere, which is why every caller keeps a typed path as a fallback
// rather than treating this as the only way in.

export type DirectoryPick =
  | { kind: "picked"; path: string }
  /** The operator dismissed the dialog. Not an error — the commonest outcome after a mis-click. */
  | { kind: "cancelled" }
  /** No picker on this platform, or the tool that provides one is not installed. */
  | { kind: "unavailable"; reason: string }

/** Long enough for someone to actually browse for a folder; short enough not to leak a process. */
const PICKER_TIMEOUT_MS = 5 * 60_000

/**
 * The timeout reaped a dialog nobody answered, possibly one nobody could SEE — it opens on the
 * server's desktop, which is not always the one in front of the operator. So it is not "cancelled",
 * which would leave the click doing nothing, and on Linux it is not "try the next tool" either: that
 * opened kdialog for another five minutes after zenity timed out. It is unavailable, and the caller's
 * fallback opens.
 */
const timedOut = (error: unknown) => (error as { killed?: unknown }).killed === true

const unanswered = (what: "folder" | "image"): DirectoryPick => ({
  kind: "unavailable",
  reason: `no ${what} was chosen within 5 minutes`,
})

// THE MACOS PANELS ARE BUILT BEFORE THE CLICK THAT SHOWS THEM.
//
// Building one takes most of a second, and almost none of that is Ntwine. Measured 2026-10-03 on macOS
// 26.6 against the live server: the request reached the server and spawned the helper in ~0.1s, and the
// dialog then took 0.8-1.0s to draw. The unified log of the operator's own three adds that afternoon
// has the same split: osascript and AppKit up in ~0.18s, then ~0.6s waiting on
// `com.apple.appkit.xpc.openAndSavePanelService`, the separate process every NSOpenPanel is hosted in
// (the private `NSUseRemoteSavePanel=NO` keeps it in-process and saves only ~0.2s). AppleScript's
// `choose folder` and `choose file` cannot be split, so each picker is an NSOpenPanel driven from JXA:
// the helper BUILDS it and then waits on stdin, and a built panel draws 82-94ms after the line that
// shows it arrives.
//
// So the browser asks for a panel as soon as the click it serves is likely — the folder panel when the
// pointer or keyboard focus reaches an "Add a project" control (`warmDirectoryPicker`, through the
// `projectPickWarm` RPC), the image panel when a project's icon menu opens (`warmImagePicker`, through
// `projectIconPickWarm`) — and the click only shows it. A panel nobody shows is killed after
// WARM_PANEL_IDLE_MS, because while it waits it holds ~55 MB of physical footprint — osascript 31 MB
// and its own instance of the panel service 24 MB, both gone with it (`footprint`; RSS reads ~150 MB,
// most of it shared framework pages): fine for a minute, not forever.

/** How long a panel built ahead of a click waits for it. */
const WARM_PANEL_IDLE_MS = 60_000

/** What a panel chooses, which is also which of the two pickers it is. */
export type PanelKind = "folder" | "image"

/**
 * The helper. Its one argument says which panel to build — `{"kind":"folder"}`, or `{"kind":"image"}`
 * with the `directory` it opens in — and it builds that panel at once, drawing it only when a line
 * `{"prompt":…}` arrives on stdin. Then it prints ONE line — `{"path":…}` or `{"cancelled":true}` — and
 * exits. End of input before that line means nobody is going to ask: it exits without drawing
 * anything, which is also what ends a waiting panel whose server has gone.
 *
 * Each panel keeps the AppleScript dialog it replaced in every visible respect. Both take one item,
 * their button reads Choose, and they float above the browser at the modal-panel level without
 * activating themselves. The folder panel takes folders only and offers New Folder. The image panel
 * takes files conforming to `public.image` — every format the rail accepts, and nothing else — and
 * opens in `directory`, which is a hint rather than a jail: the operator can browse anywhere, and a
 * directory that is not there opens wherever the OS would have.
 *
 * Accessory, so it never puts an icon in the Dock. JXA hands enum values over as STRINGS ("1") — the
 * constants and a method's return alike (`activationPolicy` reads back "1") — hence the Number() on
 * both sides of the comparison. UTType is looked up by name: its framework ships no BridgeSupport, so
 * `ObjC.import` finds "nothing found to import", but AppKit has already loaded the class.
 */
const PANEL_SCRIPT = String.raw`
ObjC.import("AppKit")
function say(message) {
  const line = $.NSString.alloc.initWithUTF8String(JSON.stringify(message) + "\n")
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(line.dataUsingEncoding($.NSUTF8StringEncoding))
}
function readLine() {
  const input = $.NSFileHandle.fileHandleWithStandardInput
  let text = ""
  while (text.indexOf("\n") < 0) {
    const data = input.availableData
    if (Number(data.length) === 0) return undefined
    text += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js
  }
  return text.slice(0, text.indexOf("\n"))
}
function run(argv) {
  const choose = JSON.parse(argv[0])
  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  const panel = $.NSOpenPanel.openPanel
  panel.allowsMultipleSelection = false
  panel.prompt = "Choose"
  if (choose.kind === "image") {
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowedContentTypes = $.NSArray.arrayWithObject($.NSClassFromString("UTType").typeWithIdentifier("public.image"))
  } else {
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.canCreateDirectories = true
  }
  if (choose.directory) panel.directoryURL = $.NSURL.fileURLWithPathIsDirectory(choose.directory, true)
  const line = readLine()
  if (line === undefined) return
  panel.message = JSON.parse(line).prompt
  const chosen = Number(panel.runModal) === Number($.NSModalResponseOK)
  say(chosen ? { path: panel.URL.path.js } : { cancelled: true })
}
`

/** The helper's command line. The panel's kind and starting directory travel as its one argument. */
function panelCommand(kind: PanelKind, directory?: string): string[] {
  return ["osascript", "-l", "JavaScript", "-e", PANEL_SCRIPT, JSON.stringify({ kind, directory })]
}

/** One native panel: built when it is opened, drawn only when `show` hands it the prompt. */
export interface NativePanel {
  /** Draw it. Settles with what the operator did, or with why the panel could not be drawn. */
  show(prompt: string): Promise<DirectoryPick>
  /** Kill a panel nobody showed. Never touches one that is showing. */
  discard(): void
  readonly exited: boolean
}

/**
 * Start building a panel. Exported, with the command as a parameter, for the test that drives this
 * protocol with a stand-in helper — a real panel is a window on the operator's desktop.
 */
export function openPanel(kind: PanelKind, command: readonly string[] = panelCommand(kind)): NativePanel {
  const [bin = "osascript", ...args] = command
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] })
  let exited = false
  let shown = false
  let reaped = false
  let stderr = ""
  let settle!: (pick: DirectoryPick) => void
  const outcome = new Promise<DirectoryPick>((resolve) => { settle = resolve })
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: { path?: unknown; cancelled?: unknown }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    // NSURL.path carries no trailing slash, except on `/` itself — which `choose folder`'s
    // `POSIX path of` also reduced to nothing, and so to "cancelled". Kept that way.
    if (typeof message.path === "string") {
      const path = message.path.replace(/\/+$/u, "")
      settle(path ? { kind: "picked", path } : { kind: "cancelled" })
    } else if (message.cancelled === true) {
      settle({ kind: "cancelled" })
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => { stderr += chunk })
  // Showing a helper that has already died writes to a closed pipe, and an EPIPE nobody listens for
  // would throw out of the event loop.
  child.stdin.on("error", () => {})
  child.on("error", (error) => {
    exited = true
    settle({ kind: "unavailable", reason: error.message })
  })
  child.on("close", () => {
    exited = true
    // A settled outcome ignores this: the answer line always arrives before the pipes close.
    settle(reaped ? unanswered(kind) : { kind: "unavailable", reason: firstLine(stderr) || `the ${kind} picker did not open` })
  })
  // A panel built ahead of a click is speculative and must never be what holds the event loop open;
  // one that is showing is somebody's answer, and is held like any other.
  const handles = [child, child.stdin, child.stdout, child.stderr] as { ref?: () => void; unref?: () => void }[]
  for (const handle of handles) handle.unref?.()
  return {
    get exited() {
      return exited
    },
    show(prompt) {
      shown = true
      for (const handle of handles) handle.ref?.()
      child.stdin.write(`${JSON.stringify({ prompt })}\n`)
      const timer = setTimeout(() => {
        reaped = true
        child.kill()
      }, PICKER_TIMEOUT_MS)
      timer.unref()
      return outcome.finally(() => clearTimeout(timer))
    },
    discard() {
      if (!shown) child.kill()
    },
  }
}

/**
 * The panels built ahead of their clicks: at most one of each kind, each with the directory it stands
 * in, because an image panel opened in one project's directory is no use to another project's click.
 */
const warm = new Map<PanelKind, { panel: NativePanel; directory: string | undefined; idle: ReturnType<typeof setTimeout> }>()

/**
 * The panel built ahead of this click, if it is still alive and stands where the click wants it. It is
 * the caller's from here on. One built for another directory is killed, not kept for a later click.
 */
function takeWarmPanel(kind: PanelKind, directory?: string): NativePanel | undefined {
  const taken = warm.get(kind)
  warm.delete(kind)
  if (!taken) return undefined
  clearTimeout(taken.idle)
  if (taken.directory !== directory) {
    taken.panel.discard()
    return undefined
  }
  return taken.panel.exited ? undefined : taken.panel
}

/** Keep one panel of this kind built, standing in `directory`, for the next WARM_PANEL_IDLE_MS. */
function warmPanel(kind: PanelKind, directory: string | undefined, open: () => NativePanel): void {
  const panel = takeWarmPanel(kind, directory) ?? open()
  const idle = setTimeout(() => {
    if (warm.get(kind)?.panel === panel) warm.delete(kind)
    panel.discard()
  }, WARM_PANEL_IDLE_MS)
  idle.unref()
  warm.set(kind, { panel, directory, idle })
}

/**
 * Build the folder panel now, because a click is about to ask for it. False where no panel is built
 * ahead (every platform but macOS). Asking again keeps the panel already built and restarts its clock.
 */
export function warmDirectoryPicker(
  platform: NodeJS.Platform = process.platform,
  open: () => NativePanel = () => openPanel("folder"),
): boolean {
  if (platform !== "darwin") return false
  warmPanel("folder", undefined, open)
  return true
}

/**
 * Build the image panel now, standing in `startIn`: the menu that offers it has just opened. As
 * warmDirectoryPicker, except that a panel already built in another directory is replaced.
 */
export function warmImagePicker(
  startIn: string | undefined,
  platform: NodeJS.Platform = process.platform,
  open: () => NativePanel = () => openPanel("image", panelCommand("image", startIn)),
): boolean {
  if (platform !== "darwin") return false
  warmPanel("image", startIn, open)
  return true
}

/**
 * Choose an IMAGE, with the dialog already standing in `startIn`.
 *
 * The rail used a browser `<input type="file">`, which cannot be aimed anywhere — the OS decides,
 * and it lands wherever you last were. A project's icon almost always lives in the project (a logo in
 * the repo, a screenshot you just took of it), so opening the picker anywhere else means navigating
 * back to a directory Ntwine already knows the path of.
 *
 * The starting directory is a hint, not a jail: the operator can still browse anywhere, which is why
 * a missing or unreadable startIn simply falls back to the OS default rather than failing.
 */
export async function pickImageFile(
  startIn: string | undefined,
  prompt = "Choose an image for this project",
  platform: NodeJS.Platform = process.platform,
  open: () => NativePanel = () => openPanel("image", panelCommand("image", startIn)),
): Promise<DirectoryPick> {
  // The panel built when the icon menu opened, or — a click nothing warned of — one built now, which
  // costs the whole build. See THE MACOS PANELS above.
  if (platform === "darwin") return (takeWarmPanel("image", startIn) ?? open()).show(prompt)
  if (platform === "linux") {
    for (const [bin, args] of [
      ["zenity", ["--file-selection", `--title=${prompt}`, ...(startIn ? [`--filename=${startIn}/`] : [])]],
      ["kdialog", ["--getopenfilename", startIn ?? ".", "image/png image/svg+xml image/webp image/jpeg image/gif"]],
    ] as const) {
      try {
        const { stdout } = await run(bin, [...args], { timeout: PICKER_TIMEOUT_MS })
        const path = stdout.trim()
        return path ? { kind: "picked", path } : { kind: "cancelled" }
      } catch (error) {
        if (timedOut(error)) return unanswered("image")
        if ((error as { code?: unknown }).code === 1) return { kind: "cancelled" }
      }
    }
    return { kind: "unavailable", reason: "install zenity or kdialog for an image picker" }
  }
  return { kind: "unavailable", reason: `no image picker on ${platform}` }
}

export async function pickDirectory(
  prompt = "Choose a folder to open in Ntwine",
  platform: NodeJS.Platform = process.platform,
  open: () => NativePanel = () => openPanel("folder"),
): Promise<DirectoryPick> {
  // The panel built when the pointer reached the button, or — a click nothing warned of — one built now,
  // which costs the whole build. See THE MACOS PANELS above.
  if (platform === "darwin") return (takeWarmPanel("folder") ?? open()).show(prompt)
  if (platform === "linux") {
    // Neither is guaranteed present; try the GNOME one, then the KDE one, then give up gracefully.
    for (const [bin, args] of [
      ["zenity", ["--file-selection", "--directory", `--title=${prompt}`]],
      ["kdialog", ["--getexistingdirectory", "."]],
    ] as const) {
      try {
        const { stdout } = await run(bin, [...args], { timeout: PICKER_TIMEOUT_MS })
        const path = stdout.trim().replace(/\/+$/u, "")
        return path ? { kind: "picked", path } : { kind: "cancelled" }
      } catch (error) {
        if (timedOut(error)) return unanswered("folder")
        // Exit 1 from either tool means "dismissed"; ENOENT means "not installed, try the next one".
        if ((error as { code?: unknown }).code === 1) return { kind: "cancelled" }
      }
    }
    return { kind: "unavailable", reason: "install zenity or kdialog for a folder picker" }
  }
  if (platform === "win32") return pickWindowsFolder(prompt)
  return { kind: "unavailable", reason: `no folder picker on ${platform}` }
}

// WINDOWS: a WinForms FolderBrowserDialog, opened from a PowerShell child.
//
// Two editions draw two dialogs. `pwsh` (PowerShell 7, .NET 8) draws the modern "Select Folder"
// dialog, with a path box the operator can paste into; Windows PowerShell 5.1 (.NET Framework, on
// every Windows install) draws the old tree, which can only be clicked through. The better one is not
// guaranteed to be installed, so it is tried first and the old one is the fallback, ENOENT deciding.
//
// AND THE DIALOG HAS TO BE RAISED, which is the whole reason this is more than one line. The server is
// a background process — the browser is the foreground one — and Windows refuses a background
// process the foreground, so the dialog opened BEHIND the browser, where nobody saw it, and sat
// there until the timeout killed it: "Add a project" read as doing nothing (measured 2026-09-18 and
// 2026-09-21 on Windows Server 2022; the "Browse For Folder" window was there, below every browser
// window). Topmost is refused the same way: SetWindowPos(HWND_TOPMOST) reports success and the style
// never takes. What works is the AttachThreadInput route: share the foreground thread's input queue
// for the one SetForegroundWindow call, then detach.
//
// The window that gets raised is an OWNER, not the dialog. ShowDialog blocks until the dialog is gone,
// so straight-line script cannot raise the dialog; a timer inside the modal loop can, but it has to
// guess which window is the dialog, and it once guessed the hidden parking window WinForms gives an
// ownerless dialog (seen 2026-09-21 on the deployed server). An owner form needs no guess: it is
// raised BEFORE the dialog opens, and a modal dialog opens on top of its active owner — that is what
// ownership means to the window manager. The form is one pixel, off-screen, and closed with the dialog.
const WINDOWS_PICKER_EDITIONS = ["pwsh", "powershell"] as const

const WINDOWS_RAISE_NATIVE =
  "Add-Type -Namespace Ntwine -Name Native -MemberDefinition '" +
  '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' +
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr pid);' +
  '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();' +
  '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);' +
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);' +
  '[DllImport("user32.dll")] public static extern bool IsHungAppWindow(System.IntPtr h);' +
  "';"

/**
 * The owner form, shown and made the foreground window; `$o` is what ShowDialog is then handed.
 *
 * It keeps a taskbar button, titled with the prompt, so the operator can find the picker again after a
 * click back into the browser buries it — an owned dialog has no taskbar button of its own, and the old
 * picker had none at all. The form itself is a pixel at -32000,-32000 that nobody sees; with `Location`
 * set, WinForms does not re-centre it on `Show`.
 *
 * The plain, sanctioned SetForegroundWindow goes first, and it is often enough: Windows grants it when
 * its foreground lock has lapsed (200 s without input, by default), and measured 2026-09-21 it took on
 * every idle run — from a background node process, even from the Task Scheduler. It is refused exactly
 * when the operator has just been clicking, which is what "Add a project" IS. Only then is the
 * foreground thread's input queue shared (AttachThreadInput) for a second attempt. That step is the
 * documented way to be refused less, not a right, and it is used for one call: when there is no
 * foreground thread (a locked desktop), or it is this thread, or its window is hung (sharing a hung
 * queue would hang the picker too), it is skipped, and the taskbar button is what is left.
 *
 * Both attempts are checked, not assumed: in 1 of 4 review rounds the first SetForegroundWindow did not
 * take even with the attach in place (the operator was mid-input), so a miss is retried a few times.
 */
const WINDOWS_RAISE_OWNER =
  "$o = New-Object System.Windows.Forms.Form -Property @{ ShowInTaskbar = $true; StartPosition = 'Manual';" +
  " Location = (New-Object System.Drawing.Point(-32000, -32000)); Size = (New-Object System.Drawing.Size(1, 1)) };" +
  "$o.Text = $d.Description;" +
  "$o.Show();" +
  "$fg = [Ntwine.Native]::GetForegroundWindow();" +
  "[void][Ntwine.Native]::SetForegroundWindow($o.Handle);" +
  "if ([Ntwine.Native]::GetForegroundWindow() -ne $o.Handle) {" +
  " $theirs = [Ntwine.Native]::GetWindowThreadProcessId($fg, [IntPtr]::Zero); $mine = [Ntwine.Native]::GetCurrentThreadId();" +
  " $attached = ($theirs -ne 0) -and ($theirs -ne $mine) -and -not [Ntwine.Native]::IsHungAppWindow($fg) -and [Ntwine.Native]::AttachThreadInput($theirs, $mine, $true);" +
  " foreach ($try in 1..4) { [void][Ntwine.Native]::SetForegroundWindow($o.Handle); if ([Ntwine.Native]::GetForegroundWindow() -eq $o.Handle) { break }; Start-Sleep -Milliseconds 50 };" +
  " if ($attached) { [void][Ntwine.Native]::AttachThreadInput($theirs, $mine, $false) } };"

/**
 * A PowerShell single-quoted literal: nothing inside it is expanded, and `'` is doubled. The curly
 * quotes U+2018..U+201B close a literal just as `'` does, so they are doubled too.
 */
function powershellLiteral(text: string): string {
  return `'${text.replace(/['\u2018-\u201b]/gu, (quote) => quote + quote)}'`
}

/**
 * The picked path is the one stdout line carrying this prefix. Anything else on stdout — a WARNING
 * both editions write there when redirected, a stray Add-Type line — is not mistaken for the path.
 */
const WINDOWS_PICKED_PREFIX = "ntwine-picked:"

function windowsFolderScript(prompt: string): string {
  // `Description` is the only prompt the old dialog has; the modern one shows it as a label beside the
  // path box unless told to use it as the title. The property exists only on .NET 8, so ask first.
  //
  // The output encoding is set first. Windows PowerShell 5.1 writes a redirected stdout in the OEM
  // code page, and node decodes it as UTF-8, so a folder with a non-ASCII name comes back mangled and
  // registers a path that does not exist. pwsh already writes UTF-8; setting it there is harmless.
  //
  // Every statement runs under Stop inside one try: PowerShell otherwise carries on past a failed
  // Add-Type or Show, reaches the final if, and exits 0 with nothing on stdout — which reads as
  // "cancelled", and the grid does nothing for a second time. A failure exits 2 with a plain message
  // on stderr (pwsh's own error rendering carries ANSI colour codes that would land in the UI).
  return (
    "$ErrorActionPreference = 'Stop'; try {" +
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;" +
    "Add-Type -AssemblyName System.Windows.Forms;" +
    WINDOWS_RAISE_NATIVE +
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog;" +
    `$d.Description = ${powershellLiteral(prompt)};` +
    "if ($d.PSObject.Properties['UseDescriptionForTitle']) { $d.UseDescriptionForTitle = $true };" +
    WINDOWS_RAISE_OWNER +
    "$r = $d.ShowDialog($o); $o.Close();" +
    `if ($r -eq 'OK') { '${WINDOWS_PICKED_PREFIX}' + $d.SelectedPath }` +
    "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }"
  )
}

/** Exported for the test that pins the edition chain; `pickDirectory` is the door. */
export async function pickWindowsFolder(
  prompt: string,
  editions: readonly string[] = WINDOWS_PICKER_EDITIONS,
): Promise<DirectoryPick> {
  const script = windowsFolderScript(prompt)
  let failure: string | undefined
  for (const edition of editions) {
    try {
      const { stdout } = await run(edition, ["-NoProfile", "-STA", "-Command", script], {
        timeout: PICKER_TIMEOUT_MS,
        // The server has no console. Without this, a console-subsystem child gets a new, visible one
        // that sits beside the dialog for as long as it is open — and can take the foreground the raise
        // just won. The rule everywhere else in the server (local-file.ts, the daemon hosts).
        windowsHide: true,
      })
      // Cancel writes no prefixed line; the dialog itself strips any trailing separator.
      const picked = stdout.split("\n").find((line) => line.startsWith(WINDOWS_PICKED_PREFIX))
      const path = picked?.slice(WINDOWS_PICKED_PREFIX.length).trim() ?? ""
      return path ? { kind: "picked", path } : { kind: "cancelled" }
    } catch (error) {
      // On a machine where the raise did not take, a timeout is the dialog nobody SAW.
      if (timedOut(error)) return unanswered("folder")
      const { code } = error as { code?: unknown }
      // ENOENT is an edition that is not installed; EPERM is one Windows would not start for this
      // process (the Store package's app-execution alias, in a profile it is not registered for); a
      // non-zero exit is the script itself failing in that edition (a pwsh without WinForms, say).
      // Each means "the next edition", not "no picker"; the last failure's reason is the one reported.
      if (code === "ENOENT" || code === "EPERM") continue
      failure = windowsFailureLine(stderrOf(error)) || "the folder picker did not open"
      if (typeof code === "number") continue
      return { kind: "unavailable", reason: failure }
    }
  }
  return { kind: "unavailable", reason: failure ?? "no PowerShell found to open a folder picker" }
}

function stderrOf(error: unknown): string {
  return typeof (error as { stderr?: unknown })?.stderr === "string"
    ? (error as { stderr: string }).stderr
    : error instanceof Error
      ? error.message
      : String(error)
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? ""
}

/** The first non-empty stderr line, with the ANSI colour codes of pwsh's error rendering stripped. */
function windowsFailureLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;]*m/gu, "")
  return plain.split("\n").map((line) => line.trim()).find(Boolean) ?? ""
}
