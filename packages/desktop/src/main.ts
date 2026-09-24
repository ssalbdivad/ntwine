import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
  type WebContents,
} from "electron"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { appPath, classifyNavigation, startAddress } from "./navigation.ts"
import { errorPage, loadingPage, projectPickerPage } from "./pages.ts"
import { frizzPaths, type FrizzPaths } from "@frizz/server/frizz-paths"
import { locateServer, startServer, type StartOutcome } from "./server.ts"
import { loginShellEnvironment } from "./shell-env.ts"

/**
 * The Frizz desktop app: a Chromium window onto the Frizz server, and as little else as possible.
 *
 * The server is found or started by server.ts and runs on the system Node; nothing here serves or
 * renders Frizz itself. What this file adds is what a browser gives a tab for free and a bare
 * BrowserWindow does not: links that open in the operator's real browser, the Edit menu macOS needs
 * before copy and paste work at all, back and forward, a context menu, and a window that remembers
 * where it was. Quitting leaves the server running, as closing a browser tab does — the scheduler,
 * PR watchers and wakes keep working, and the next launch joins it.
 */

const APP_ID = "dev.frizz.app"
const here = dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === "darwin"

app.setName("Frizz")
// NOT Electron's default for an app named Frizz: on macOS that is ~/Library/Application Support/Frizz,
// which is Frizz's own data and state root (frizz-paths.ts), and Chromium would fill it with a browser
// profile. One directory of its own, whether this runs from the checkout or packaged.
// setPath throws for a directory that does not exist yet, which on a first launch this one does not.
const userData = join(app.getPath("appData"), "Frizz Desktop")
mkdirSync(userData, { recursive: true })
app.setPath("userData", userData)
if (process.platform === "win32") app.setAppUserModelId(APP_ID)

/** The server this app is showing — the one origin its windows may navigate within. */
let origin: string | undefined
let mainWindow: BrowserWindow | undefined
/** One search-or-start at a time, shared by every window that is waiting on it. */
let pending: Promise<StartOutcome> | undefined

const statePath = () => join(app.getPath("userData"), "window-state.json")
const launcherLogPath = () => join(app.getPath("logs"), "launcher.log")

interface WindowState {
  bounds?: Rectangle
  maximized?: boolean
  /** The in-app path last shown, restored on the next launch against whatever server that finds. */
  path?: string
}

function readWindowState(): WindowState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as WindowState
  } catch {
    return {}
  }
}

function saveWindowState(win: BrowserWindow): void {
  const url = win.webContents.getURL()
  const state: WindowState = {
    ...readWindowState(),
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
  }
  const path = origin ? appPath(url, origin) : undefined
  if (path) state.path = path
  try {
    mkdirSync(dirname(statePath()), { recursive: true })
    writeFileSync(statePath(), JSON.stringify(state))
  } catch {
    // Losing the window position is not worth failing a quit over.
  }
}

/** Saved bounds, unless the display they were on is gone — then only the size survives. */
function restorableBounds(bounds: Rectangle | undefined): Partial<Rectangle> {
  if (!bounds) return { width: 1400, height: 900 }
  const visible = screen.getAllDisplays().some(({ workArea: area }) =>
    bounds.x < area.x + area.width && bounds.x + bounds.width > area.x &&
    bounds.y < area.y + area.height && bounds.y + bounds.height > area.y)
  return visible ? bounds : { width: bounds.width, height: bounds.height }
}

function windowOptions(): BrowserWindowConstructorOptions {
  const icon = join(here, "icon.png")
  return {
    minWidth: 420,
    minHeight: 360,
    show: false,
    // The board's own first-paint colours, so a document load (switching projects is one) never
    // flashes white between pages.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d0e10" : "#f7f7f7",
    autoHideMenuBar: true,
    title: "Frizz",
    ...(process.platform === "linux" && existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  }
}

function createMainWindow(): BrowserWindow {
  const state = readWindowState()
  const win = new BrowserWindow({ ...windowOptions(), ...restorableBounds(state.bounds) })
  if (state.maximized) win.maximize()
  win.once("ready-to-show", () => win.show())
  win.on("close", () => saveWindowState(win))
  win.on("closed", () => { if (mainWindow === win) mainWindow = undefined })
  mainWindow = win
  void connect(win)
  return win
}

/** Whatever window should answer "bring Frizz to the front". */
function focusApp(): void {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
  if (!win) {
    createMainWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** A launch already in progress — someone else's lease with no listener yet — is waited for, not raced. */
async function waitForRunningServer(roots?: FrizzPaths): Promise<string | "starting" | undefined> {
  const deadline = Date.now() + 10 * 60_000
  for (;;) {
    const found = await locateServer({ roots })
    if (found !== "starting" || Date.now() > deadline) return found
    progress("waiting for the Frizz launch already in progress")
    // Every other second: on Windows, each read of a live owner record runs PowerShell synchronously.
    await delay(2_000)
  }
}

/** A progress line for every window still showing this app's loading screen. */
function progress(line: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.getURL().startsWith("data:")) continue
    win.webContents
      .executeJavaScript(`document.getElementById("detail")?.replaceChildren(${JSON.stringify(line)})`)
      .catch(() => {})
  }
}

/**
 * The Frizz server: the one running, or one started now from `cwd`.
 *
 * FRIZZ_DESKTOP_URL skips the search and shows that origin — a board on a non-default port, or a
 * disposable one somebody is testing against.
 */
async function resolveServer(cwd: string): Promise<StartOutcome> {
  if (process.env.FRIZZ_DESKTOP_URL) return { kind: "ready", origin: new URL(process.env.FRIZZ_DESKTOP_URL).origin }
  const inProgress = { kind: "failed", message: "A Frizz launch has been starting for 10 minutes and has not come up.", needsProject: false } as const
  let found = await waitForRunningServer()
  if (found === "starting") return inProgress
  if (found) return { kind: "ready", origin: found }
  progress("starting the server")
  const env = await loginShellEnvironment()
  // The launcher resolves Frizz's roots from THIS environment, and a login shell can move them (an
  // XDG_STATE_HOME exported in an rc file), so look there too before starting a second server.
  const roots = frizzPaths({ env })
  found = await waitForRunningServer(roots)
  if (found === "starting") return inProgress
  if (found) return { kind: "ready", origin: found }
  return startServer({ env, cwd, roots, logPath: launcherLogPath(), onProgress: progress })
}

/**
 * Point `win` at the Frizz server, at `path` if given and otherwise where the last session ended.
 * Every window shows its own loading screen but shares the one search-or-start in flight.
 */
async function connect(win: BrowserWindow, options: { cwd?: string; path?: string } = {}): Promise<void> {
  const show = async (url: string) => {
    if (!win.isDestroyed()) await win.loadURL(url).catch(() => {})
  }
  await show(loadingPage("looking for a running server"))
  pending ??= resolveServer(options.cwd ?? homedir())
    .catch((error: unknown): StartOutcome => ({ kind: "failed", message: error instanceof Error ? error.message : String(error), needsProject: false }))
    .finally(() => { pending = undefined })
  const outcome = await pending
  if (win.isDestroyed()) return
  if (outcome.kind === "failed") {
    // The launcher's own wording for the first-run case tells a terminal user to cd somewhere.
    await show(outcome.needsProject ? projectPickerPage() : errorPage({ message: outcome.message, logPath: launcherLogPath() }))
    return
  }
  origin = outcome.origin
  await show(startAddress(options.path ?? readWindowState().path, outcome.origin))
  // The loading screen was this app's, not a page anybody visited: Back must not return to it.
  if (!win.isDestroyed()) win.webContents.navigationHistory.clear()
}

function goBack(win: BrowserWindow | null | undefined): void {
  if (win?.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack()
}

function goForward(win: BrowserWindow | null | undefined): void {
  if (win?.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward()
}

function openInNewWindow(url: string): void {
  const win = new BrowserWindow({ ...windowOptions(), width: 1100, height: 800 })
  win.once("ready-to-show", () => win.show())
  void win.loadURL(url)
}

const lastReconnect = new WeakMap<WebContents, number>()
const lastCrash = new WeakMap<WebContents, number>()

/** Records now, and answers whether the previous record is under 30 seconds old. */
function tooSoon(log: WeakMap<WebContents, number>, contents: WebContents): boolean {
  const previous = log.get(contents)
  log.set(contents, Date.now())
  return previous !== undefined && Date.now() - previous < 30_000
}

/** Everything a page could ask to open, routed by where it belongs (see navigation.ts). */
function guardNavigation(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const target = classifyNavigation(url, origin)
    // The board's own pages open as windows of this app — ⌘-click on a thread opens its full page.
    // Such a window is the operator's, not its opener's: closing the board must not close it too.
    if (target === "app") {
      return { action: "allow", outlivesOpener: true, overrideBrowserWindowOptions: { ...windowOptions(), show: true, width: 1100, height: 800 } }
    }
    if (target === "external") void shell.openExternal(url)
    return { action: "deny" }
  })
  contents.on("will-navigate", (event, url) => {
    // The loading and error pages are data: URLs this app loads itself (loadURL is not a
    // page-initiated navigation, so it never reaches here); a page may only move within the board.
    const target = classifyNavigation(url, origin)
    if (target === "app") return
    event.preventDefault()
    if (target === "external") void shell.openExternal(url)
  })
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED: another navigation replaced this one, which is not a failure.
    if (!isMainFrame || code === -3 || !origin || classifyNavigation(url, origin) !== "app") return
    const win = BrowserWindow.fromWebContents(contents)
    if (!win) return
    // The server went away: find or start it again, and come back to the page that failed. Once per
    // half-minute per window — a server that answers the search but not the page would loop.
    if (tooSoon(lastReconnect, contents)) {
      void contents.loadURL(errorPage({ title: "Lost the connection to Frizz", message: `${description} — ${url}` }))
      return
    }
    void connect(win, { path: appPath(url, origin) })
  })
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return
    // A reload cures a one-off crash. A page that crashes as it loads would reload forever, and a
    // launch or integrity failure is not the page's fault at all, so those show the error instead.
    if (tooSoon(lastCrash, contents) || details.reason === "launch-failed" || details.reason === "integrity-failure") {
      void contents.loadURL(errorPage({ title: "The page crashed", message: `Chromium reported: ${details.reason}.` }))
      return
    }
    contents.reload()
  })
  contents.on("context-menu", (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.linkURL) {
      const target = classifyNavigation(params.linkURL, origin)
      if (target === "app") items.push({ label: "Open link in new window", click: () => openInNewWindow(params.linkURL) })
      if (target === "external") items.push({ label: "Open link in browser", click: () => void shell.openExternal(params.linkURL) })
      items.push({ label: "Copy link address", click: () => clipboard.writeText(params.linkURL) })
    }
    if (params.mediaType === "image" && params.srcURL) {
      items.push({ label: "Copy image", click: () => contents.copyImageAt(params.x, params.y) })
    }
    if (params.isEditable) {
      if (items.length) items.push({ type: "separator" })
      for (const suggestion of params.dictionarySuggestions) {
        items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })
      }
      if (params.dictionarySuggestions.length) items.push({ type: "separator" })
      items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" }, { role: "selectAll" })
    } else if (params.selectionText.trim()) {
      if (items.length) items.push({ type: "separator" })
      items.push({ role: "copy" })
    }
    if (items.length) Menu.buildFromTemplate(items).popup()
  })
}

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: [
        {
          label: "New window",
          accelerator: "CmdOrCtrl+N",
          click: () => (origin ? openInNewWindow(`${origin}/`) : focusApp()),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    // Without an Edit menu macOS routes ⌘C/⌘V/⌘X/⌘A nowhere — including paste into the terminal.
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Back", accelerator: isMac ? "Cmd+[" : "Alt+Left", click: () => goBack(BrowserWindow.getFocusedWindow()) },
        { label: "Forward", accelerator: isMac ? "Cmd+]" : "Alt+Right", click: () => goForward(BrowserWindow.getFocusedWindow()) },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]
  return Menu.buildFromTemplate(template)
}

/** The data: pages this app draws are the only ones allowed to ask for a reconnect. */
function fromOwnPage(event: IpcMainEvent): BrowserWindow | undefined {
  if (!event.senderFrame?.url.startsWith("data:")) return undefined
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", focusApp)
  app.on("web-contents-created", (_event, contents) => guardNavigation(contents))
  app.on("browser-window-created", (_event, win) => {
    // The trackpad swipe on macOS. (Mouse back/forward buttons need nothing: Chromium already
    // navigates on them, and handling their app-command too went back two pages per click.)
    win.on("swipe", (_e, direction) => {
      if (direction === "left") goBack(win)
      if (direction === "right") goForward(win)
    })
  })

  ipcMain.on("frizz-desktop:focus-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (isMac) app.focus({ steal: true })
  })
  ipcMain.on("frizz-desktop:retry", (event) => {
    const win = fromOwnPage(event)
    if (win) void connect(win)
  })
  ipcMain.on("frizz-desktop:choose-project", async (event) => {
    const win = fromOwnPage(event)
    if (!win) return
    const choice = await dialog.showOpenDialog(win, {
      title: "Choose a project folder",
      buttonLabel: "Open in Frizz",
      properties: ["openDirectory"],
    })
    if (!choice.canceled && choice.filePaths[0]) void connect(win, { cwd: choice.filePaths[0] })
  })

  app.on("window-all-closed", () => {
    if (!isMac) app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu())
    createMainWindow()
  })
}
